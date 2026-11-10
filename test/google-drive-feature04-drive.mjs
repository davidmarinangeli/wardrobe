import { createHash } from "node:crypto";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_ID = "root_00001";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function makeDrive(rootId = ROOT_ID) {
  const nodes = new Map();
  const sessions = new Map();
  let sequence = 1;
  let lostChunkAck = false;
  let expireQuery = false;
  let listingError = null;
  const counters = { createFolder: 0, createFile: 0, updateFile: 0, copyFile: 0, deleteFile: 0, chunks: 0, starts: 0, maxChunkBytes: 0 };
  const makeId = () => `drive_${String(sequence++).padStart(6, "0")}`;
  const root = {
    id: rootId, name: "Wardrobe archive", mimeType: FOLDER_MIME, parents: [], trashed: false,
    capabilities: { canListChildren: true, canAddChildren: true, canEdit: true, canDelete: true },
  };
  nodes.set(root.id, { ...root, appProperties: undefined });

  function metadata(node) {
    const value = { ...node };
    delete value.content;
    return value;
  }

  function addFile({ id = makeId(), name, mimeType = "application/octet-stream", parentId = rootId, bytes, appProperties }) {
    const content = Buffer.from(bytes || []);
    const node = {
      id, name, mimeType, parents: [parentId], trashed: false,
      size: String(content.length), sha256Checksum: digest(content), appProperties: appProperties ? { ...appProperties } : undefined,
      capabilities: { canDownload: true, canModifyContent: true, canEdit: true, canDelete: true, canListChildren: true, canAddChildren: true },
      content,
    };
    nodes.set(id, node);
    return node;
  }

  function addFolder({ id = makeId(), name, parentId = rootId, appProperties }) {
    const node = {
      id, name, mimeType: FOLDER_MIME, parents: [parentId], trashed: false,
      appProperties: appProperties ? { ...appProperties } : undefined,
      capabilities: { canDownload: false, canModifyContent: false, canEdit: true, canDelete: true, canListChildren: true, canAddChildren: true },
    };
    nodes.set(id, node);
    return node;
  }

  const notFound = () => Object.assign(new Error("not found"), { status: 404, code: "file_not_found" });
  const client = {
    async verifyRoot() { return metadata(nodes.get(rootId)); },
    async listChildren(parentId = rootId) {
      if (listingError) throw listingError;
      if (!nodes.has(parentId)) throw notFound();
      return [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(parentId)).map(metadata);
    },
    async getMetadata(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      return metadata(node);
    },
    async readFile(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      if (node.mimeType === FOLDER_MIME) throw new Error("folder has no content");
      return Buffer.from(node.content);
    },
    async hashFile(id) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      return { size: node.content.length, sha256: digest(node.content) };
    },
    async downloadFile(id, write) {
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      const bytes = Buffer.from(node.content);
      for (let offset = 0; offset < bytes.length; offset += 8192) await write(bytes.subarray(offset, offset + 8192));
      return { size: bytes.length, sha256: digest(bytes) };
    },
    async generateId() { return makeId(); },
    async createFolder({ id = makeId(), name, parentId = rootId, appProperties }) {
      counters.createFolder += 1;
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFolder({ id, name, parentId, appProperties }));
    },
    async createFile({ id = makeId(), name, mimeType, bytes, parentId = rootId, appProperties }) {
      counters.createFile += 1;
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFile({ id, name, mimeType, bytes, parentId, appProperties }));
    },
    async updateFile({ fileId, name, mimeType, bytes, appProperties }) {
      counters.updateFile += 1;
      const node = nodes.get(fileId);
      if (!node || node.trashed) throw notFound();
      if (name !== undefined) node.name = name;
      if (mimeType !== undefined) node.mimeType = mimeType;
      if (bytes !== undefined) {
        node.content = Buffer.from(bytes);
        node.size = String(node.content.length);
        node.sha256Checksum = digest(node.content);
      }
      if (appProperties !== undefined) node.appProperties = { ...appProperties };
      return metadata(node);
    },
    async copyFile({ fileId, id = makeId(), name, parentId = rootId, appProperties }) {
      counters.copyFile += 1;
      const source = nodes.get(fileId);
      if (!source || source.trashed) throw notFound();
      if (nodes.has(id)) return metadata(nodes.get(id));
      return metadata(addFile({ id, name, mimeType: source.mimeType, parentId, bytes: source.content, appProperties }));
    },
    async deleteFile(id) {
      counters.deleteFile += 1;
      const node = nodes.get(id);
      if (!node || node.trashed) throw notFound();
      if (node.mimeType === FOLDER_MIME && [...nodes.values()].some((child) => !child.trashed && child.parents?.includes(id))) {
        throw new Error("folder is not empty");
      }
      node.trashed = true;
    },
    async startResumableUpload({ name, mimeType, size, parentId, id, fileId, appProperties }) {
      counters.starts += 1;
      const uploadId = makeId();
      const sessionUrl = `https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${encodeURIComponent(fileId)}` : ""}?uploadType=resumable&supportsAllDrives=true&fields=id&upload_id=${uploadId}&session_crd=fake`;
      sessions.set(uploadId, { name, mimeType, size, parentId, id: fileId || id, fileId: fileId || null, appProperties, bytes: Buffer.alloc(0) });
      return { sessionUrl };
    },
    async queryResumableUpload({ sessionUrl }) {
      const uploadId = new URL(sessionUrl).searchParams.get("upload_id");
      const session = sessions.get(uploadId);
      if (expireQuery) {
        expireQuery = false;
        sessions.delete(uploadId);
        throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      }
      if (!session) throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      if (session.bytes.length >= session.size) {
        const node = finalizeSession(session);
        return { complete: true, offset: session.size, metadata: metadata(node) };
      }
      return { complete: false, offset: session.bytes.length };
    },
    async uploadResumableChunk({ sessionUrl, offset, bytes }) {
      counters.chunks += 1;
      const uploadId = new URL(sessionUrl).searchParams.get("upload_id");
      const session = sessions.get(uploadId);
      if (!session) throw Object.assign(new Error("expired"), { code: "resumable_session_expired", status: 410 });
      if (offset !== session.bytes.length) throw new Error("bad fake offset");
      counters.maxChunkBytes = Math.max(counters.maxChunkBytes, bytes.length);
      session.bytes = Buffer.concat([session.bytes, Buffer.from(bytes)]);
      if (lostChunkAck) { lostChunkAck = false; throw Object.assign(new Error("lost upload acknowledgement"), { code: "google_unavailable", retryable: true }); }
      if (session.bytes.length >= session.size) {
        const node = finalizeSession(session);
        return { complete: true, offset: session.size, metadata: metadata(node) };
      }
      return { complete: false, offset: session.bytes.length };
    },
  };

  function finalizeSession(session) {
    let node;
    if (session.fileId) {
      node = nodes.get(session.fileId);
      if (!node) throw notFound();
      node.name = session.name;
      node.mimeType = session.mimeType;
      node.parents = [session.parentId];
      node.content = Buffer.from(session.bytes);
      node.size = String(node.content.length);
      node.sha256Checksum = digest(node.content);
      node.appProperties = session.appProperties ? { ...session.appProperties } : undefined;
    } else {
      node = nodes.get(session.id);
      if (!node) node = addFile({ id: session.id, name: session.name, mimeType: session.mimeType, parentId: session.parentId, bytes: session.bytes, appProperties: session.appProperties });
      else {
        node.content = Buffer.from(session.bytes);
        node.size = String(node.content.length);
        node.sha256Checksum = digest(node.content);
        node.appProperties = session.appProperties ? { ...session.appProperties } : undefined;
      }
    }
    sessions.delete([...sessions.entries()].find(([, value]) => value === session)?.[0]);
    return node;
  }

  return {
    client, nodes, counters, addFile, addFolder,
    loseNextChunkAck() { lostChunkAck = true; },
    expireNextSessionQuery() { expireQuery = true; },
    failListings(error = Object.assign(new Error("provider private detail"), { status: 403, code: "folder_read_denied" })) { listingError = error; },
    allowListings() { listingError = null; },
    children(parentId = rootId) { return [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(parentId)); },
    async cloneToRoot(newRootId) {
      const copied = makeDrive(newRootId);
      const sourceChildren = [...nodes.values()].filter((node) => !node.trashed && node.parents?.includes(rootId));
      const copyTree = async (node, parentId) => {
        const newId = await copied.client.generateId();
        if (node.mimeType === FOLDER_MIME) {
          const folder = copied.addFolder({ id: newId, name: node.name, parentId });
          for (const child of [...nodes.values()].filter((entry) => !entry.trashed && entry.parents?.includes(node.id))) await copyTree(child, folder.id);
          return folder;
        }
        return copied.addFile({ id: newId, name: node.name, mimeType: node.mimeType, parentId, bytes: node.content });
      };
      for (const child of sourceChildren) await copyTree(child, newRootId);
      return copied;
    },
  };
}
