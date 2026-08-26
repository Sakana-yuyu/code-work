import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CodeworkProjectFile, CODEWORK_PROJECT_FILE_SCHEMA_URL } from "@codework/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link CodeworkProjectFile}.
 */
export const CodeworkProjectFileFromJson = fromLenientJson(CodeworkProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(CodeworkProjectFileFromJson);

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT3ProjectFile(contents: string): CodeworkProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link CODEWORK_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(CodeworkProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CODEWORK_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
