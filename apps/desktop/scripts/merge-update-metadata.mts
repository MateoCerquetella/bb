import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const updateFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const updateMetadataSchema = z
  .object({
    version: z.string().min(1),
    files: z.array(updateFileSchema).min(1),
    path: z.string().min(1),
    sha512: z.string().min(1),
    releaseDate: z.string().min(1),
  })
  .passthrough();

type UpdateMetadata = z.infer<typeof updateMetadataSchema>;

export function mergeUpdateMetadata(
  primaryValue: unknown,
  secondaryValue: unknown,
): UpdateMetadata {
  const primary = updateMetadataSchema.parse(primaryValue);
  const secondary = updateMetadataSchema.parse(secondaryValue);

  if (primary.version !== secondary.version) {
    throw new Error(
      `Cannot merge macOS update metadata for different versions: ${primary.version} and ${secondary.version}`,
    );
  }

  const filesByUrl = new Map(
    [...primary.files, ...secondary.files].map((file) => [file.url, file]),
  );

  return {
    ...primary,
    files: [...filesByUrl.values()],
  };
}

async function main(): Promise<void> {
  const secondaryPathArgument = process.argv[2];
  if (secondaryPathArgument === undefined) {
    throw new Error(
      "Usage: pnpm run desktop:merge-update-metadata -- <secondary-mac-yml>",
    );
  }

  const packageRoot = process.cwd();
  const releaseChannel = resolveDesktopReleaseChannel(process.env);
  const releaseConfig = createDesktopReleaseConfig(releaseChannel);
  const primaryPath = resolve(
    packageRoot,
    "release",
    releaseConfig.updateMetadataFileName,
  );
  const secondaryPath = resolve(packageRoot, secondaryPathArgument);
  const [primaryText, secondaryText] = await Promise.all([
    readFile(primaryPath, "utf8"),
    readFile(secondaryPath, "utf8"),
  ]);
  const merged = mergeUpdateMetadata(
    parseYaml(primaryText),
    parseYaml(secondaryText),
  );

  await writeFile(primaryPath, stringifyYaml(merged), "utf8");
  process.stdout.write(`Merged ${secondaryPath} into ${primaryPath}\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  await main();
}
