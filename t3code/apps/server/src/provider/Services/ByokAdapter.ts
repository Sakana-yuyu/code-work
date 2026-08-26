/**
 * ByokAdapter — shape type for the cursor-byok gateway provider adapter.
 *
 * The driver model ({@link ../Drivers/ByokDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor (mirrors {@link ./OpenCodeAdapter.ts}).
 *
 * @module ByokAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * ByokAdapterShape — per-instance cursor-byok adapter contract. Carries a
 * branded driver kind as the nominal discriminant.
 */
export interface ByokAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
