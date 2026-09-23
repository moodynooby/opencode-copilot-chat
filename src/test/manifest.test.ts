import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

interface ProviderContribution {
  vendor: string;
  configuration?: {
    required?: string[];
  };
}

interface ExtensionManifest {
  contributes: {
    languageModelChatProviders: ProviderContribution[];
  };
}

const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as ExtensionManifest;

describe("extension manifest — provider authentication", () => {
  it("allows anonymous Zen discovery while keeping Go credentials required", () => {
    const go = manifest.contributes.languageModelChatProviders.find((provider) => provider.vendor === "opencodego");
    const zen = manifest.contributes.languageModelChatProviders.find((provider) => provider.vendor === "opencodezen");
    assert.ok(go);
    assert.ok(zen);
    assert.deepEqual(go.configuration?.required, ["apiKey"]);
    assert.equal(zen.configuration?.required, undefined);
  });
});
