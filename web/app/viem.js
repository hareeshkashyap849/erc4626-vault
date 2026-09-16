/**
 * A stable name for the vendored viem.
 *
 * The file in ../vendor/ has a hash in its name so that two packages with the
 * same basename cannot collide, which means application code should never import
 * it directly. Everything imports ./viem.js instead, and a version bump is a
 * one-line change here rather than a search across the app.
 *
 * This exists as a separate module rather than a re-export inside wallet.js so
 * that the vendored dependency has exactly one importer, and so a test can mock
 * viem by pointing at a different module rather than by intercepting a path.
 */
export * from '../vendor/npm_viem_2.56.5__esm.592722b2e8.js';