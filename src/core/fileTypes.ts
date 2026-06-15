import path from "node:path";
import type { FileType } from "../types/domain.js";

const extensionMap: Record<string, FileType> = {
  ".pdf": "Document",
  ".doc": "Document",
  ".docx": "Document",
  ".txt": "Document",
  ".md": "Document",
  ".rtf": "Document",
  ".xls": "Spreadsheet",
  ".xlsx": "Spreadsheet",
  ".csv": "Spreadsheet",
  ".ppt": "Presentation",
  ".pptx": "Presentation",
  ".jpg": "Image",
  ".jpeg": "Image",
  ".png": "Image",
  ".gif": "Image",
  ".webp": "Image",
  ".heic": "Image",
  ".svg": "Image",
  ".mp4": "Video",
  ".mov": "Video",
  ".avi": "Video",
  ".mkv": "Video",
  ".wmv": "Video",
  ".mp3": "Audio",
  ".wav": "Audio",
  ".m4a": "Audio",
  ".flac": "Audio",
  ".zip": "ArchivePackage",
  ".rar": "ArchivePackage",
  ".7z": "ArchivePackage",
  ".tar": "ArchivePackage",
  ".gz": "ArchivePackage",
  ".java": "Code",
  ".py": "Code",
  ".js": "Code",
  ".ts": "Code",
  ".tsx": "Code",
  ".jsx": "Code",
  ".html": "Code",
  ".css": "Code",
  ".json": "Code",
  ".xml": "Code",
  ".yml": "Code",
  ".yaml": "Code",
  ".exe": "Installer",
  ".msi": "Installer",
  ".dmg": "Installer",
  ".pkg": "Installer"
};

export function getFileType(filePath: string): FileType {
  const extension = path.extname(filePath).toLowerCase();
  return extensionMap[extension] ?? "Other";
}

export function getExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(".", "");
}

