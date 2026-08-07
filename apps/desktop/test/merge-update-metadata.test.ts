import { describe, expect, it } from "vitest";
import { mergeUpdateMetadata } from "../scripts/merge-update-metadata.mjs";

function metadata(version: string, arch: "arm64" | "x64") {
  const zip = `bb-${version}-${arch}.zip`;
  return {
    version,
    files: [
      { url: zip, sha512: `${arch}-zip-sha`, size: 10 },
      {
        url: `bb-${version}-${arch}.dmg`,
        sha512: `${arch}-dmg-sha`,
        size: 20,
      },
    ],
    path: zip,
    sha512: `${arch}-zip-sha`,
    releaseDate: "2026-08-07T00:00:00.000Z",
  };
}

describe("mergeUpdateMetadata", () => {
  it("combines updater files from native arm64 and x64 builds", () => {
    const merged = mergeUpdateMetadata(
      metadata("1.2.3", "arm64"),
      metadata("1.2.3", "x64"),
    );

    expect(merged.files.map((file) => file.url)).toEqual([
      "bb-1.2.3-arm64.zip",
      "bb-1.2.3-arm64.dmg",
      "bb-1.2.3-x64.zip",
      "bb-1.2.3-x64.dmg",
    ]);
  });

  it("rejects metadata from different versions", () => {
    expect(() =>
      mergeUpdateMetadata(metadata("1.2.3", "arm64"), metadata("1.2.4", "x64")),
    ).toThrow("different versions");
  });
});
