import { open } from "node:fs/promises";

// Windows cannot fsync a directory handle (FlushFileBuffers on a directory
// fails with EPERM); NTFS journals the rename and create metadata itself, so
// there is nothing further to flush. Every other platform keeps the strict
// behaviour and surfaces the error.
const UNSUPPORTED_ON_WINDOWS = new Set(["EPERM", "EISDIR", "EINVAL", "EBADF"]);

function ignorable(error) {
  return process.platform === "win32" && UNSUPPORTED_ON_WINDOWS.has(error?.code);
}

/** Flushes a directory entry table after a create or rename (a no-op where the OS cannot). */
export async function fsyncDirectory(directory) {
  let handle;
  try { handle = await open(directory, "r"); }
  catch (error) { if (ignorable(error)) return; throw error; }
  try { await handle.sync(); }
  catch (error) { if (!ignorable(error)) throw error; }
  finally { await handle.close(); }
}
