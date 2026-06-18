import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function safeMoveFile(sourcePath: string, targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (!isNodeErrorCode(error, "EXDEV")) throw error;
    await copyThenDeleteSource(sourcePath, targetPath);
  }
}

async function copyThenDeleteSource(sourcePath: string, targetPath: string) {
  let copied = false;
  try {
    await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
    copied = true;
    await preserveFileTimes(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  } catch (error) {
    if (copied) {
      await fs.unlink(targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function preserveFileTimes(sourcePath: string, targetPath: string) {
  try {
    const stat = await fs.stat(sourcePath);
    await fs.utimes(targetPath, stat.atime, stat.mtime);
  } catch {
    // Metadata preservation is best-effort; the file move itself is the critical operation.
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
