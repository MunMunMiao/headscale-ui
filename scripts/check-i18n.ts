import { resolve } from "node:path";
import { getCatalogs } from "@lingui/cli/api";
import { getConfig } from "@lingui/conf";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../src/i18n/locales";

async function run(script: string, args: string[] = []): Promise<void> {
  const child = Bun.spawn([process.execPath, "run", script, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`${script} failed`);
}

async function checkI18n(): Promise<void> {
  const config = getConfig({ configPath: resolve("lingui.config.ts") });
  if (
    config.sourceLocale !== DEFAULT_LOCALE ||
    JSON.stringify([...config.locales].sort()) !== JSON.stringify([...SUPPORTED_LOCALES].sort())
  )
    throw new Error("Lingui must contain all 11 supported locales with en-US as source");
  const catalogs = await getCatalogs(config);
  const files: string[] = [];
  for (const catalog of catalogs) {
    const source = await catalog.read(DEFAULT_LOCALE);
    if (!source || Object.keys(source).length === 0) throw new Error("Source catalog is empty");
    const sourceIds = Object.keys(source).sort();
    for (const locale of SUPPORTED_LOCALES) {
      const messages = await catalog.read(locale);
      if (!messages) throw new Error(`${locale}: catalog is missing`);
      if (JSON.stringify(Object.keys(messages).sort()) !== JSON.stringify(sourceIds)) {
        throw new Error(`${locale}: message IDs do not match the source catalog`);
      }
      for (const [id, message] of Object.entries(messages)) {
        if (message.obsolete) throw new Error(`${locale}: obsolete message ${id}`);
        if (!message.translation) throw new Error(`${locale}: missing translation ${id}`);
      }
      files.push(catalog.getFilename(locale));
    }
  }
  async function snapshot(): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    for (const filename of files.toSorted()) {
      hasher.update(filename);
      hasher.update(await Bun.file(filename).arrayBuffer());
    }
    return hasher.digest("hex");
  }
  const before = await snapshot();
  await run("i18n:extract");
  const first = await snapshot();
  if (first !== before)
    throw new Error("Catalogs changed during extraction; review and rerun i18n:check");
  await run("i18n:extract");
  if ((await snapshot()) !== first) throw new Error("Catalog extraction is not deterministic");
  await run("i18n:compile", ["--strict"]);
  console.log(
    `Lingui catalogs verified: ${SUPPORTED_LOCALES.length} locales, no missing or obsolete messages, extraction is stable.`,
  );
}

try {
  await checkI18n();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
