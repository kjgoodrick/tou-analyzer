import { importExtensionUsageCsv } from "./mosaicData";
import { ImportResult } from "./types";

const EXTENSION_ID_PLACEHOLDER = "__UTILITY_ENERGY_DOWNLOADER_EXTENSION_ID__";
const EXTENSION_ID = import.meta.env.VITE_UTILITY_ENERGY_DOWNLOADER_EXTENSION_ID?.trim() || EXTENSION_ID_PLACEHOLDER;

interface ChromeRuntime {
  sendMessage?: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void
  ) => void;
  lastError?: { message?: string };
}

declare global {
  interface Window {
    chrome?: {
      runtime?: ChromeRuntime;
    };
  }
}

interface BridgeResponse {
  ok?: boolean;
  format?: string;
  status?: string;
  file?: {
    name?: string;
    kind?: string;
    mimeType?: string;
    text?: string;
  };
  message?: string;
  error?: string;
}

export function bridgeConfigured(): boolean {
  return EXTENSION_ID !== EXTENSION_ID_PLACEHOLDER;
}

export async function requestCsvFromExtension(): Promise<ImportResult> {
  const runtime = window.chrome?.runtime;
  const sendMessage = runtime?.sendMessage;
  if (!sendMessage || !bridgeConfigured()) {
    throw new Error("The extension bridge is not configured for this deployment.");
  }

  const response = await new Promise<BridgeResponse>((resolve, reject) => {
    sendMessage(
      EXTENSION_ID,
      { type: "ENERGY_USAGE_EXPORT_FOR_TOU_ANALYZER", format: "usage-csv-v1" },
      value => {
        const error = runtime.lastError?.message;
        if (error) {
          reject(new Error(error));
        } else {
          resolve((value ?? {}) as BridgeResponse);
        }
      }
    );
  });

  if (!response.ok || response.format !== "usage-csv-v1" || response.file?.kind !== "csv" || !response.file.text) {
    throw new Error(response.message || response.error || "The extension did not share a CSV usage file.");
  }

  return importExtensionUsageCsv(
    response.file.text,
    response.file.name || "energy-usage-extension.csv",
    response.file.mimeType || "text/csv"
  );
}
