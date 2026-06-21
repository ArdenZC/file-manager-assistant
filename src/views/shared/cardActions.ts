import { tauriApi } from "../../api/tauriApi";
import { readableError } from "../../utils/viewHelpers";

export interface RevealFileFromCardOptions {
  path: string;
  onError: (message: string) => void;
  stopPropagation: () => void;
  reveal?: (path: string) => Promise<void>;
}

export async function revealFileFromCard({
  path,
  onError,
  stopPropagation,
  reveal = tauriApi.revealInFolder
}: RevealFileFromCardOptions): Promise<void> {
  stopPropagation();
  try {
    await reveal(path);
  } catch (error) {
    onError(readableError(error));
  }
}

