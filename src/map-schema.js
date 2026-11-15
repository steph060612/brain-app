// The map format version: the one place it is defined. The mapper writes it; the server, the status check,
// brainmap, the tool server and the diagram (bundled by Vite) all import it from here, so none of them can read
// a different version than the mapper writes. Bump it here when the map format changes. No dependencies, so it
// loads in Node and in the browser.
export const SCHEMA_VERSION = 13;
