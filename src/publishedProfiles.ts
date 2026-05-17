import { importUsageFile } from "./mosaicData";
import { ImportResult } from "./types";

export interface PublishedProfile {
  id: string;
  label: string;
  fileName: string;
  path: string;
}

export const PUBLISHED_PROFILES: PublishedProfile[] = [
  {
    id: "schedule-1-residential-average-2021-2023",
    label: "sample data",
    fileName: "schedule-1-residential-average-2021-2023-duckdb-wasm.parquet",
    path: "/sample-data/schedule-1-residential-average-2021-2023-duckdb-wasm.parquet"
  }
];

export async function importPublishedProfile(profile: PublishedProfile): Promise<ImportResult> {
  const response = await fetch(profile.path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${profile.label}.`);
  }
  const blob = await response.blob();
  return importUsageFile(new File([blob], profile.fileName, { type: "application/vnd.apache.parquet" }));
}
