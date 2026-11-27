import { createHash } from "node:crypto";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const GOOGLE_MIME_PREFIX = "application/vnd.google-apps.";
const MAX_DEPTH = 32;
const MAX_PAGES = 100;
const MAX_FILES = 50_000;
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_STREAMED_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const FIELDS = "id,name,mimeType,parents,trashed,capabilities,driveId,size,modifiedTime,version,md5Checksum,sha256Checksum,appProperties,webViewLink";

export class GoogleDriveClientError extends Error {
  constructor(code, message, { status = 400, retryable = false } = {}) {
    super(message);
    this.name = "GoogleDriveClientError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function fail(code, message, options) { throw new GoogleDriveClientError(code, message, options); }

function validId(value) {
  return typeof value === "string" && value.length >= 5 && value.length <= 200 && /^[A-Za-z0-9_-]+$/.test(value);
}

function assertId(value, label = "Drive id") {
  if (!validId(value)) fail("invalid_drive_id", `${label} is malformed`);
  return value;
}

function drivePath(id) { return `${DRIVE_API}/files/${encodeURIComponent(id)}`; }

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !validId(value.id) || typeof value.name !== "string" || !value.name
      || typeof value.mimeType !== "string" || !value.mimeType
      || typeof value.trashed !== "boolean"
      || !value.capabilities || typeof value.capabilities !== "object" || Array.isArray(value.capabilities)
      || !(value.parents === undefined || (Array.isArray(value.parents) && value.parents.every(validId)))
      || !(value.driveId === undefined || value.driveId === null || validId(value.driveId))) {
    fail("malformed_drive_metadata", "Google Drive returned malformed file metadata", { status: 502 });
  }
  if (value.mimeType === SHORTCUT_MIME) fail("shortcut_not_supported", "Drive shortcuts are outside the configured archive boundary", { status: 403 });
  if (value.trashed) fail("file_trashed", "The requested Drive file has been moved to trash", { status: 404 });
  return value;
}

function validateName(name) {
  if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\0\r\n/\\]/.test(name)) {
    fail("invalid_file_name", "A valid Drive file name is required");
  }
  return name;
}

function validateContentType(value) {
  if (typeof value !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(value) || value.toLowerCase().startsWith(GOOGLE_MIME_PREFIX)) {
    fail("invalid_mime_type", "Google-native documents cannot be stored in the archive");
  }
  return value;
}

function validateAppProperties(properties) {
  if (properties === undefined) return undefined;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) fail("invalid_app_properties", "Drive application metadata is invalid");
  const allowed = new Set(["wardrobeSha256", "wardrobePath", "wardrobeVersion"]);
  const entries = Object.entries(properties);
  if (entries.length > 3) fail("invalid_app_properties", "Drive application metadata is invalid");
  const clean = {};
  for (const [key, value] of entries) {
    if (!allowed.has(key) || typeof value !== "string"
        || Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") > 124
        || /[\0\r\n]/.test(value)) {
      fail("invalid_app_properties", "Drive application metadata is invalid");
    }
    clean[key] = value;
  }
  return clean;
}

function validateGeneratedId(id) {
  if (!validId(id)) fail("invalid_drive_id", "A generated Drive id is malformed");
  return id;
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function validateUploadSessionUrl(value, fileId = null) {
  let url;
  try { url = new URL(value); } catch { fail("invalid_upload_session", "Google Drive returned an invalid upload session"); }
  const ids = url.searchParams.getAll("upload_id");
  // Google echoes the request's query (supportsAllDrives, fields) and adds its own (session_crd).
  const expectedPath = fileId ? `/upload/drive/v3/files/${encodeURIComponent(fileId)}` : "/upload/drive/v3/files";
  if (url.protocol !== "https:" || url.origin !== "https://www.googleapis.com"
      || url.pathname !== expectedPath || url.username || url.password || url.hash
      || ids.length !== 1 || !ids[0] || ids[0].length > 1024 || /[\0\r\n]/.test(ids[0])
      || (url.searchParams.has("uploadType") && url.searchParams.get("uploadType") !== "resumable")) {
    fail("invalid_upload_session", "Google Drive returned an invalid upload session");
  }
  return url.toString();
}

function confirmedOffset(headers, total) {
  const range = headerValue(headers, "range");
  if (range === null || range === "") return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  if (!match) fail("malformed_upload_range", "Google Drive returned an invalid upload offset", { status: 502 });
  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) fail("malformed_upload_range", "Google Drive returned an invalid upload offset", { status: 502 });
  return offset;
}

function asBuffer(bytes) {
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) fail("invalid_file_bytes", "File content must be bytes");
  const result = Buffer.from(bytes);
  if (result.length > MAX_CONTENT_BYTES) fail("file_too_large", "This file exceeds the supported Drive transfer size");
  return result;
}

function multipart(metadata, bytes, mimeType) {
  const boundary = `wardrobe_${Buffer.from(cryptoRandom()).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return { boundary, body };
}

function cryptoRandom() {
  // This module has no other randomness requirement; defer to Node's built-in
  // Web Crypto so the boundary is never predictable from archive contents.
  return globalThis.crypto.getRandomValues(new Uint8Array(18));
}

function ensureObjectResponse(response, operation) {
  if (!response || typeof response !== "object" || !response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    fail("malformed_drive_response", `Google Drive returned an invalid response for ${operation}`, { status: 502 });
  }
  return response.data;
}

/**
 * Creates a Drive API surface whose every operation is bounded to one verified
 * folder. `request` is an authenticated server-only transport that accepts
 * `{ method, url, query, headers, body, responseType }` and returns
 * `{ status, data, bytes, headers }`.
 */
export function createBoundedDriveClient({ folderId, request, expectedDriveId, assertCurrentTarget = async () => {} } = {}) {
  assertId(folderId, "Configured folder id");
  if (expectedDriveId !== undefined && expectedDriveId !== null) assertId(expectedDriveId, "Expected shared drive id");
  if (typeof request !== "function") throw new TypeError("A server-side Drive request function is required");

  let rootDriveId;

  async function current() { await assertCurrentTarget(); }

  async function send(input) {
    await current();
    try {
      const response = await request(input);
      await current();
      return response;
    } catch (error) {
      await current();
      throw error;
    }
  }

  async function rawMetadata(id) {
    await current();
    const response = await send({ method: "GET", url: drivePath(assertId(id)), query: { supportsAllDrives: "true", fields: FIELDS } });
    await current();
    const metadata = normalizeMetadata(ensureObjectResponse(response, "file metadata"));
    if (metadata.id !== id) fail("drive_metadata_id_mismatch", "Google Drive returned metadata for a different file", { status: 502 });
    return metadata;
  }

  function checkDrive(metadata) {
    if (rootDriveId === undefined) return;
    const actual = metadata.driveId || null;
    if (actual !== rootDriveId) fail("foreign_shared_drive", "The requested file is outside the configured Drive or shared drive", { status: 403 });
  }

  async function ancestry(id, { allowRoot = true } = {}) {
    assertId(id);
    await current();
    if (id === folderId) {
      if (!allowRoot) fail("root_mutation_forbidden", "The configured archive folder cannot be modified or deleted", { status: 403 });
      const root = await rawMetadata(folderId);
      validateRootMetadata(root);
      rootDriveId = root.driveId || null;
      return root;
    }

    const seen = new Set();
    let metadata = await rawMetadata(id);
    const requested = metadata;
    let depth = 0;
    while (metadata.id !== folderId) {
      if (seen.has(metadata.id)) fail("drive_ancestry_cycle", "Drive folder ancestry contains a cycle", { status: 502 });
      seen.add(metadata.id);
      depth += 1;
      if (depth > MAX_DEPTH) fail("drive_ancestry_too_deep", "The Drive folder ancestry is too deep to validate", { status: 403 });
      if (!Array.isArray(metadata.parents) || metadata.parents.length !== 1) fail("drive_parent_ambiguous", "The Drive file does not have one unambiguous parent", { status: 403 });
      checkDrive(metadata);
      const parentId = assertId(metadata.parents[0], "Drive parent id");
      if (parentId === folderId) {
        const root = await rawMetadata(folderId);
        validateRootMetadata(root);
        rootDriveId = root.driveId || null;
        checkDrive(requested);
        return requested;
      }
      metadata = await rawMetadata(parentId);
      if (metadata.mimeType !== FOLDER_MIME) fail("drive_parent_not_folder", "A Drive parent is not a folder", { status: 403 });
    }
    return requested;
  }

  function validateRootMetadata(metadata) {
    if (metadata.id !== folderId || metadata.mimeType !== FOLDER_MIME) fail("invalid_root_folder", "The configured Drive destination is not a real folder", { status: 403 });
    if (expectedDriveId !== undefined && (metadata.driveId || null) !== expectedDriveId) fail("target_changed", "The configured Drive folder moved to a different drive", { status: 409 });
    if (metadata.mimeType === SHORTCUT_MIME) fail("shortcut_not_supported", "The configured Drive destination cannot be a shortcut", { status: 403 });
    if (metadata.capabilities.canListChildren !== true) fail("folder_read_denied", "The configured Drive folder cannot be listed", { status: 403 });
    if (metadata.capabilities.canAddChildren !== true) fail("folder_write_denied", "The configured Drive folder cannot accept archive files", { status: 403 });
  }

  async function validateParent(parentId = folderId) {
    assertId(parentId, "Parent folder id");
    const parent = await ancestry(parentId);
    if (parent.mimeType !== FOLDER_MIME) fail("parent_not_folder", "Drive files can only be placed in a folder", { status: 400 });
    if (parent.capabilities.canListChildren !== true) fail("folder_read_denied", "The Drive folder cannot be listed", { status: 403 });
    if (parent.capabilities.canAddChildren !== true) fail("folder_write_denied", "The Drive folder cannot accept files", { status: 403 });
    return parent;
  }

  async function verifyRoot() {
    const root = await ancestry(folderId);
    validateRootMetadata(root);
    const children = await listChildren(folderId);
    await current();
    return Object.freeze({
      id: root.id,
      name: root.name,
      driveId: root.driveId || null,
      readable: true,
      writable: true,
      childCount: children.length,
    });
  }

  async function getMetadata(id) {
    assertId(id);
    const metadata = await ancestry(id);
    await current();
    return metadata;
  }

  async function listChildren(parentId = folderId) {
    const parent = await validateParent(parentId);
    const escapedParent = parent.id.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
    const params = {
      q: `'${escapedParent}' in parents and trashed = false`,
      fields: `nextPageToken,incompleteSearch,files(${FIELDS})`,
      pageSize: "1000",
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      corpora: parent.driveId ? "drive" : "user",
    };
    if (parent.driveId) params.driveId = parent.driveId;

    const all = [];
    const ids = new Set();
    const pageTokens = new Set();
    let pageToken;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      await current();
      const query = { ...params };
      if (pageToken !== undefined) query.pageToken = pageToken;
      const response = await send({ method: "GET", url: `${DRIVE_API}/files`, query });
      await current();
      const value = response?.data;
      if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.files)
          || !(value.incompleteSearch === undefined || typeof value.incompleteSearch === "boolean")) {
        fail("malformed_drive_listing", "Google Drive returned an invalid folder listing", { status: 502 });
      }
      if (value.incompleteSearch === true) fail("incomplete_drive_listing", "Google Drive could not complete the folder listing", { status: 502, retryable: true });
      for (const entry of value.files) {
        const metadata = normalizeMetadata(entry);
        if (ids.has(metadata.id)) fail("duplicate_drive_id", "Google Drive returned a duplicate file", { status: 502 });
        ids.add(metadata.id);
        if (!Array.isArray(metadata.parents) || metadata.parents.length !== 1 || metadata.parents[0] !== parent.id) {
          fail("drive_parent_mismatch", "Google Drive returned a file outside the requested folder", { status: 502 });
        }
        checkDrive(metadata);
        all.push(metadata);
        if (all.length > MAX_FILES) fail("drive_listing_too_large", "The Drive folder exceeds the supported listing size", { status: 413 });
      }
      const next = value.nextPageToken;
      if (next === undefined || next === null || next === "") {
        await current();
        return all;
      }
      if (typeof next !== "string" || next.length > 2048 || /[\0\r\n]/.test(next)) fail("malformed_page_token", "Google Drive returned a malformed page token", { status: 502 });
      if (pageTokens.has(next)) fail("repeated_page_token", "Google Drive repeated a folder-listing page", { status: 502 });
      pageTokens.add(next);
      pageToken = next;
    }
    fail("drive_listing_too_many_pages", "The Drive folder has too many listing pages", { status: 413 });
  }

  async function readFile(fileId) {
    const metadata = await ancestry(assertId(fileId), { allowRoot: false });
    if (metadata.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be read as archive files", { status: 415 });
    if (metadata.capabilities.canDownload !== true) fail("file_read_denied", "This Drive file cannot be downloaded", { status: 403 });
    const size = Number(metadata.size);
    if (Number.isFinite(size) && size > MAX_CONTENT_BYTES) fail("file_too_large", "This Drive file exceeds the supported transfer size", { status: 413 });
    await current();
    const response = await send({ method: "GET", url: drivePath(metadata.id), query: { alt: "media", supportsAllDrives: "true" }, responseType: "bytes" });
    await current();
    if (!(Buffer.isBuffer(response?.bytes) || response?.bytes instanceof Uint8Array)) fail("malformed_drive_response", "Google Drive returned invalid file content", { status: 502 });
    const bytes = Buffer.from(response.bytes);
    if (bytes.length > MAX_CONTENT_BYTES) fail("file_too_large", "This Drive file exceeds the supported transfer size", { status: 413 });
    await current();
    return bytes;
  }

  async function hashFile(fileId) {
    const metadata = await ancestry(assertId(fileId), { allowRoot: false });
    if (metadata.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be read as archive files", { status: 415 });
    if (metadata.capabilities.canDownload !== true) fail("file_read_denied", "This Drive file cannot be downloaded", { status: 403 });
    const declaredSize = metadata.size === undefined ? null : Number(metadata.size);
    if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_STREAMED_FILE_BYTES)) {
      fail("file_too_large", "This Drive file exceeds the streamed verification limit", { status: 413 });
    }
    const response = await send({ method: "GET", url: drivePath(metadata.id), query: { alt: "media", supportsAllDrives: "true" }, responseType: "stream" });
    const hash = createHash("sha256");
    let size = 0;
    const consume = async (chunk) => {
      await current();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_STREAMED_FILE_BYTES) fail("file_too_large", "This Drive file exceeds the streamed verification limit", { status: 413 });
      hash.update(bytes);
      await current();
    };
    const stream = response?.stream;
    try {
      if (stream?.getReader) {
        const reader = stream.getReader();
        try {
          while (true) {
            await current();
            const part = await reader.read();
            await current();
            if (part.done) break;
            await consume(part.value);
          }
        } finally { reader.releaseLock?.(); }
      } else if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const part of stream) await consume(part);
      } else if (response?.bytes || response?.data instanceof Uint8Array) {
        await consume(response.bytes || response.data);
      } else fail("malformed_drive_response", "Google Drive returned invalid streamed content", { status: 502 });
    } catch (error) {
      await current();
      throw error;
    }
    await current();
    const digest = hash.digest("hex");
    if (declaredSize !== null && declaredSize !== size) fail("remote_checksum_mismatch", "The Drive file size does not match its metadata", { status: 502 });
    if (metadata.sha256Checksum && metadata.sha256Checksum.toLowerCase() !== digest) fail("remote_checksum_mismatch", "The Drive file checksum does not match its content", { status: 502 });
    await ancestry(metadata.id, { allowRoot: false });
    await current();
    return { size, sha256: digest };
  }

  async function downloadFile(fileId, writeChunk) {
    if (typeof writeChunk !== "function") throw new TypeError("A streamed file sink is required");
    const metadata = await ancestry(assertId(fileId), { allowRoot: false });
    if (metadata.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be downloaded as archive files", { status: 415 });
    if (metadata.capabilities.canDownload !== true) fail("file_read_denied", "This Drive file cannot be downloaded", { status: 403 });
    const declaredSize = metadata.size === undefined ? null : Number(metadata.size);
    if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_STREAMED_FILE_BYTES)) {
      fail("file_too_large", "This Drive file exceeds the streamed download limit", { status: 413 });
    }
    const response = await send({ method: "GET", url: drivePath(metadata.id), query: { alt: "media", supportsAllDrives: "true" }, responseType: "stream" });
    const hash = createHash("sha256");
    let size = 0;
    const consume = async (chunk) => {
      await current();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_STREAMED_FILE_BYTES) fail("file_too_large", "This Drive file exceeds the streamed download limit", { status: 413 });
      hash.update(bytes);
      await writeChunk(bytes);
      await current();
    };
    const stream = response?.stream;
    try {
      if (stream?.getReader) {
        const reader = stream.getReader();
        try {
          while (true) {
            await current();
            const part = await reader.read();
            await current();
            if (part.done) break;
            await consume(part.value);
          }
        } finally { reader.releaseLock?.(); }
      } else if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const part of stream) await consume(part);
      } else if (response?.bytes || response?.data instanceof Uint8Array) {
        await consume(response.bytes || response.data);
      } else fail("malformed_drive_response", "Google Drive returned invalid streamed content", { status: 502 });
    } catch (error) {
      await current();
      throw error;
    }
    await current();
    const digest = hash.digest("hex");
    if (declaredSize !== null && declaredSize !== size) fail("remote_checksum_mismatch", "The Drive file size does not match its metadata", { status: 502 });
    if (metadata.sha256Checksum && metadata.sha256Checksum.toLowerCase() !== digest) fail("remote_checksum_mismatch", "The Drive file checksum does not match its content", { status: 502 });
    await ancestry(metadata.id, { allowRoot: false });
    await current();
    return { size, sha256: digest };
  }

  async function createFolder({ name, parentId = folderId, id, appProperties } = {}) {
    validateName(name);
    const parent = await validateParent(parentId);
    await current();
    const response = await send({
      method: "POST",
      url: `${DRIVE_API}/files`,
      query: { supportsAllDrives: "true", fields: FIELDS },
      body: {
        ...(id ? { id: validateGeneratedId(id) } : {}),
        name, mimeType: FOLDER_MIME, parents: [parent.id],
        ...(appProperties ? { appProperties: validateAppProperties(appProperties) } : {}),
      },
      headers: { "Content-Type": "application/json" },
    });
    await current();
    const created = normalizeMetadata(ensureObjectResponse(response, "folder creation"));
    if (created.mimeType !== FOLDER_MIME || created.parents?.length !== 1 || created.parents[0] !== parent.id) fail("created_file_outside_target", "Google Drive created a folder outside the verified destination", { status: 502 });
    await ancestry(created.id);
    await current();
    return created;
  }

  async function createFile({ name, mimeType, bytes, parentId = folderId, appProperties, id } = {}) {
    validateName(name);
    const contentType = validateContentType(mimeType);
    const content = asBuffer(bytes);
    const props = validateAppProperties(appProperties);
    const parent = await validateParent(parentId);
    const metadata = { ...(id ? { id: validateGeneratedId(id) } : {}), name, mimeType: contentType, parents: [parent.id], ...(props ? { appProperties: props } : {}) };
    const multi = multipart(metadata, content, contentType);
    await current();
    const response = await send({
      method: "POST",
      url: `${UPLOAD_API}/files`,
      query: { uploadType: "multipart", supportsAllDrives: "true", fields: FIELDS },
      body: multi.body,
      headers: { "Content-Type": `multipart/related; boundary=${multi.boundary}` },
    });
    await current();
    const created = normalizeMetadata(ensureObjectResponse(response, "file creation"));
    if (created.parents?.length !== 1 || created.parents[0] !== parent.id || created.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("created_file_outside_target", "Google Drive created a file outside the verified destination", { status: 502 });
    await ancestry(created.id);
    await current();
    return created;
  }

  async function updateFile({ fileId, name, mimeType, bytes, appProperties } = {}) {
    const id = assertId(fileId);
    if (id === folderId) fail("root_mutation_forbidden", "The configured archive folder cannot be modified or deleted", { status: 403 });
    const existing = await ancestry(id, { allowRoot: false });
    const hasBytes = bytes !== undefined;
    if (hasBytes && existing.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be replaced as archive files", { status: 415 });
    const hasMetadata = name !== undefined || mimeType !== undefined || appProperties !== undefined;
    if (!hasBytes && !hasMetadata) fail("empty_update", "At least one Drive file field must be updated");
    if (hasBytes && existing.capabilities.canModifyContent !== true) fail("file_write_denied", "This Drive file cannot be replaced", { status: 403 });
    if (hasMetadata && existing.capabilities.canEdit !== true) fail("file_edit_denied", "This Drive file metadata cannot be changed", { status: 403 });
    const metadata = {};
    if (name !== undefined) metadata.name = validateName(name);
    if (mimeType !== undefined) metadata.mimeType = validateContentType(mimeType);
    if (appProperties !== undefined) metadata.appProperties = validateAppProperties(appProperties);
    await current();
    let response;
    if (hasBytes) {
      const contentType = mimeType === undefined ? existing.mimeType : validateContentType(mimeType);
      const multi = multipart(metadata, asBuffer(bytes), contentType);
      response = await send({
        method: "PATCH",
        url: `${UPLOAD_API}/files/${encodeURIComponent(id)}`,
        query: { uploadType: "multipart", supportsAllDrives: "true", fields: FIELDS },
        body: multi.body,
        headers: { "Content-Type": `multipart/related; boundary=${multi.boundary}` },
      });
    } else {
      response = await send({
        method: "PATCH",
        url: drivePath(id),
        query: { supportsAllDrives: "true", fields: FIELDS },
        body: metadata,
        headers: { "Content-Type": "application/json" },
      });
    }
    await current();
    const updated = normalizeMetadata(ensureObjectResponse(response, "file update"));
    if (updated.id !== id || updated.mimeType === FOLDER_MIME || updated.parents?.length !== existing.parents?.length
        || updated.parents?.some((parentId, index) => parentId !== existing.parents[index])) {
      fail("updated_file_moved", "Google Drive changed the file placement during an update", { status: 502 });
    }
    await ancestry(id, { allowRoot: false });
    await current();
    return updated;
  }

  async function deleteFile(fileId) {
    const id = assertId(fileId);
    if (id === folderId) fail("root_mutation_forbidden", "The configured archive folder cannot be modified or deleted", { status: 403 });
    const metadata = await ancestry(id, { allowRoot: false });
    if (metadata.capabilities.canDelete !== true) fail("file_delete_denied", "This Drive file cannot be deleted", { status: 403 });
    await current();
    await send({ method: "DELETE", url: drivePath(id), query: { supportsAllDrives: "true" }, responseType: "none" });
    await current();
    return { id, deleted: true };
  }

  async function generateId() {
    const response = await send({
      method: "GET", url: `${DRIVE_API}/files/generateIds`,
      query: { count: "1", space: "drive", type: "files" },
    });
    const data = response?.data;
    if (!data || !Array.isArray(data.ids) || data.ids.length !== 1) fail("malformed_drive_response", "Google Drive did not return a generated id", { status: 502 });
    return validateGeneratedId(data.ids[0]);
  }

  async function copyFile({ fileId, name, parentId = folderId, id, appProperties } = {}) {
    const sourceId = assertId(fileId, "Source file id");
    const source = await ancestry(sourceId, { allowRoot: false });
    if (source.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be copied into the archive", { status: 415 });
    const parent = await validateParent(parentId);
    const metadata = {
      ...(id ? { id: validateGeneratedId(id) } : {}),
      name: validateName(name || source.name),
      parents: [parent.id],
      ...(appProperties ? { appProperties: validateAppProperties(appProperties) } : {}),
    };
    const response = await send({
      method: "POST", url: `${DRIVE_API}/files/${encodeURIComponent(sourceId)}/copy`,
      query: { supportsAllDrives: "true", fields: FIELDS }, body: metadata,
      headers: { "Content-Type": "application/json" },
    });
    const copied = normalizeMetadata(ensureObjectResponse(response, "file copy"));
    if (copied.parents?.length !== 1 || copied.parents[0] !== parent.id || copied.mimeType.startsWith(GOOGLE_MIME_PREFIX)) {
      fail("created_file_outside_target", "Google Drive copied a file outside the verified destination", { status: 502 });
    }
    await ancestry(copied.id, { allowRoot: false });
    return copied;
  }

  async function startResumableUpload({ name, mimeType, size, parentId = folderId, id, fileId, appProperties } = {}) {
    validateName(name);
    const contentType = validateContentType(mimeType);
    if (!Number.isSafeInteger(size) || size < 0) fail("invalid_file_size", "A valid upload size is required");
    const parent = await validateParent(parentId);
    const existingFileId = fileId ? assertId(fileId) : null;
    const generatedId = id ? validateGeneratedId(id) : null;
    if (existingFileId) {
      const existing = await ancestry(existingFileId, { allowRoot: false });
      if (existing.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("google_document_not_supported", "Google-native documents cannot be replaced as archive files", { status: 415 });
      if (existing.parents?.length !== 1 || existing.parents[0] !== parent.id || existing.capabilities.canModifyContent !== true
          || (appProperties && existing.capabilities.canEdit !== true)) {
        fail("file_write_denied", "This Drive file cannot be replaced", { status: 403 });
      }
    }
    const metadata = {
      ...(!existingFileId && generatedId ? { id: generatedId } : {}), name, mimeType: contentType,
      ...(!existingFileId ? { parents: [parent.id] } : {}),
      ...(appProperties ? { appProperties: validateAppProperties(appProperties) } : {}),
    };
    let response;
    let requestError;
    try {
      response = await send({
        method: existingFileId ? "PATCH" : "POST", url: `${UPLOAD_API}/files${existingFileId ? `/${encodeURIComponent(existingFileId)}` : ""}`,
        query: { uploadType: "resumable", supportsAllDrives: "true", fields: FIELDS },
        body: metadata,
        headers: { "Content-Type": "application/json", "X-Upload-Content-Type": contentType, "X-Upload-Content-Length": String(size) },
        responseType: "upload",
      });
    } catch (error) { requestError = error; }
    let boundaryError;
    try {
      await validateParent(parent.id);
      if (existingFileId) {
        const currentFile = await ancestry(existingFileId, { allowRoot: false });
        if (currentFile.parents?.length !== 1 || currentFile.parents[0] !== parent.id
            || currentFile.mimeType.startsWith(GOOGLE_MIME_PREFIX) || currentFile.capabilities.canModifyContent !== true
            || (appProperties && currentFile.capabilities.canEdit !== true)) {
          fail("updated_file_moved", "The resumable upload target moved during session creation", { status: 409 });
        }
      }
    } catch (error) { boundaryError = error; }
    if (boundaryError) throw boundaryError;
    if (requestError) throw requestError;
    const sessionUrl = validateUploadSessionUrl(headerValue(response?.headers, "location"), existingFileId);
    return { sessionUrl, parentId: parent.id, fileId: existingFileId };
  }

  async function resumableRequest({ sessionUrl, offset, total, bytes, probe = false, parentId, fileId = null } = {}) {
    const safeUrl = validateUploadSessionUrl(sessionUrl, fileId);
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(offset) || offset < 0 || offset > total) {
      fail("invalid_upload_offset", "The saved upload offset is invalid");
    }
    const parent = await validateParent(parentId);
    if (fileId) {
      const existing = await ancestry(assertId(fileId), { allowRoot: false });
      if (existing.parents?.length !== 1 || existing.parents[0] !== parent.id || existing.mimeType.startsWith(GOOGLE_MIME_PREFIX)
          || existing.capabilities.canModifyContent !== true) fail("file_write_denied", "The resumable upload target is outside the verified archive", { status: 403 });
    }
    const chunk = probe ? Buffer.alloc(0) : asBuffer(bytes);
    if (!probe && (!chunk.length || chunk.length > MAX_RESUMABLE_CHUNK_BYTES || chunk.length % (256 * 1024) !== 0 && offset + chunk.length < total)) {
      fail("invalid_upload_chunk", "The upload chunk has an invalid size");
    }
    const end = probe ? "*" : String(offset + chunk.length - 1);
    let response;
    let requestError;
    try {
      response = await send({
        method: "PUT", url: safeUrl,
        headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${probe ? "*" : `${offset}-${end}`}/${total}` },
        body: probe ? undefined : chunk,
        responseType: "upload",
      });
    } catch (error) { requestError = error; }
    let boundaryError;
    try {
      await validateParent(parent.id);
      if (fileId) {
        const currentFile = await ancestry(fileId, { allowRoot: false });
        if (currentFile.parents?.length !== 1 || currentFile.parents[0] !== parent.id
            || currentFile.mimeType.startsWith(GOOGLE_MIME_PREFIX) || currentFile.capabilities.canModifyContent !== true
            || currentFile.capabilities.canEdit !== true) {
          fail("updated_file_moved", "The resumable upload target moved during transfer", { status: 409 });
        }
      }
    } catch (error) { boundaryError = error; }
    if (boundaryError) throw boundaryError;
    if (requestError) throw requestError;
    const status = response?.status;
    if (status === 308) return { complete: false, offset: confirmedOffset(response.headers, total) };
    if (status === 404 || status === 410) fail("resumable_session_expired", "The upload session expired", { status, retryable: true });
    if (status < 200 || status >= 300) fail("google_unavailable", "Google Drive could not accept the upload chunk", { status: 502, retryable: status >= 500 });
    const metadata = normalizeMetadata(ensureObjectResponse(response, "resumable upload"));
    if (metadata.parents?.length !== 1 || metadata.parents[0] !== parent.id || metadata.mimeType.startsWith(GOOGLE_MIME_PREFIX)) fail("created_file_outside_target", "Google Drive completed an upload outside the verified destination", { status: 502 });
    await ancestry(metadata.id, { allowRoot: false });
    return { complete: true, offset: total, metadata };
  }

  async function queryResumableUpload({ sessionUrl, total, parentId, fileId } = {}) {
    return resumableRequest({ sessionUrl, offset: 0, total, probe: true, parentId, fileId });
  }

  async function uploadResumableChunk(options = {}) {
    if (!Number.isSafeInteger(options.offset) || options.offset + (options.bytes?.length || 0) !== options.endOffset) {
      // The end offset is an explicit fence against callers persisting a guessed acknowledgement.
      if (options.endOffset !== undefined) fail("invalid_upload_offset", "The upload chunk bounds are invalid");
    }
    return resumableRequest(options);
  }

  return Object.freeze({ verifyRoot, getMetadata, listChildren, readFile, hashFile, downloadFile, createFolder, createFile, updateFile, deleteFile, generateId, copyFile, startResumableUpload, queryResumableUpload, uploadResumableChunk });
}
