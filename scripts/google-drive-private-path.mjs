import path from "node:path";

const PRIVATE_DIRECTORY_COMPONENT = ".google-drive";

/** True for lexical or real filesystem paths containing the reserved state directory name. */
export function hasGoogleDrivePrivatePathComponent(value) {
  return path.resolve(value).split(path.sep).some((component) => component.toLowerCase() === PRIVATE_DIRECTORY_COMPONENT);
}
