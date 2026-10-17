// Single chokepoint for productfoo's only third-party runtime dependency (`yaml`).
// The build bundles THIS one file with esbuild into a self-contained
// dist/src/vendorYaml.js, so the committed dist runs from a bare clone with no
// `npm install` at all (npm-installer-v0 R-013). Every other module imports
// yaml through here (`./vendorYaml.js`), never the bare "yaml" specifier — that
// is what lets the dynamic packet-command loader resolve with no node_modules.
export { parse, stringify, YAMLParseError } from "yaml";
