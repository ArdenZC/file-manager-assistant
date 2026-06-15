import path from "node:path";
import type { FileRecord, OperationPreview } from "../types/domain.js";
import { randomId } from "./id.js";

export function createOperationPreviews(files: FileRecord[]): OperationPreview[] {
  return files
    .filter((file) =>
      ["Move", "Rename", "MoveAndRename", "Archive"].includes(file.suggested_action)
    )
    .filter((file) => file.risk_level !== "Sensitive")
    .map((file) => {
      const targetDirectory =
        file.suggested_target_path || (file.suggested_action === "Rename" ? file.directory : "");
      const newName = file.suggested_name || file.name;
      const targetPath = targetDirectory ? path.join(targetDirectory, newName) : file.path;
      const isMove = targetDirectory && path.resolve(targetDirectory) !== path.resolve(file.directory);
      const isRename = newName !== file.name;
      const operationType: OperationPreview["operation_type"] =
        isMove && isRename ? "move_rename" : isMove ? "move" : "rename";
      return {
        id: randomId("op"),
        fileId: file.id,
        operation_type: operationType,
        source_path: file.path,
        target_path: targetPath,
        old_name: file.name,
        new_name: newName,
        status: "pending" as const,
        risk_level: file.risk_level,
        confidence: file.confidence,
        requires_confirmation: file.requires_confirmation,
        reason: file.classification_reason
      };
    })
    .filter((operation) => operation.source_path !== operation.target_path);
}
