import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { requireThat } from "./types.ts";
import type { AccountConfig, Strategy } from "./types.ts";

export type Settings = {
  database: string;
  reports: string;
  account: AccountConfig;
  strategy: Strategy;
  validationData?: string;
};
export function loadSettings(file: string): Settings {
  const settings = JSON.parse(readFileSync(file, "utf8")) as Settings;
  requireThat(
    typeof settings.database === "string" && typeof settings.reports === "string",
    "配置需要 database 和 reports 路径",
  );
  const base = dirname(resolve(file));
  return {
    ...settings,
    database: resolve(base, settings.database),
    reports: resolve(base, settings.reports),
    ...(settings.validationData && { validationData: resolve(base, settings.validationData) }),
  };
}
