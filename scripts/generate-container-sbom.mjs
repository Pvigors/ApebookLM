#!/usr/bin/env node

/** Generate a minimal SPDX 2.3 package SBOM for a locally built Docker image. */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const image = args[0];
const componentIndex = args.indexOf("--component");
const explicitComponent = componentIndex >= 0 ? args[componentIndex + 1] : undefined;
if (!image || componentIndex >= 0 && !explicitComponent) {
  console.error("usage: generate-container-sbom.mjs <docker-image> [--component web|cad-worker]");
  process.exit(2);
}
if (explicitComponent && explicitComponent !== "web" && explicitComponent !== "cad-worker") {
  throw new Error("--component must be web or cad-worker");
}

const imageRepository = image.split("@")[0].split("/").at(-1)?.split(":")[0] || "apebooklm";
const inferredComponent = /(?:^|[-_])cad(?:[-_]worker)?(?:$|[-_])/i.test(imageRepository)
  ? "cad-worker"
  : "web";
const component = explicitComponent || inferredComponent;

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
  throw new Error(`unexpected Docker image id:${imageId}`);
}

const osRows = docker([
  "run", "--rm", "--entrypoint", "sh", image, "-c",
  "dpkg-query -W -f='${Package}\\t${Version}\\t${Architecture}\\n' | LC_ALL=C sort",
]).split(/\r?\n/).filter(Boolean).map((line) => {
  const [name, version, arch] = line.split("\t");
  return { ecosystem: "deb", name, version, arch };
});

const npmRows = JSON.parse(docker([
  "run", "--rm", "--entrypoint", "node", image, "-e",
  String.raw`
    const fs=require("fs"),path=require("path");
    const root="/app/node_modules", seen=new Map();
    function walk(dir,depth=0){
      if(depth>8 || !fs.existsSync(dir)) return;
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        if(!entry.isDirectory()) continue;
        const full=path.join(dir,entry.name);
        const pkg=path.join(full,"package.json");
        if(fs.existsSync(pkg)){
          try{const meta=JSON.parse(fs.readFileSync(pkg,"utf8"));
            if(meta.name&&meta.version) seen.set(meta.name+"@"+meta.version,{name:meta.name,version:meta.version});
          }catch{}
        }
        if(entry.name.startsWith("@")) walk(full,depth+1);
        walk(path.join(full,"node_modules"),depth+1);
      }
    }
    walk(root);
    process.stdout.write(JSON.stringify([...seen.values()].sort((a,b)=>(a.name+"@"+a.version).localeCompare(b.name+"@"+b.version))));
  `,
]));

const safeId = (value) => value.replace(/[^A-Za-z0-9.-]/g, "-");
const packages = [];
const relationships = [];
const imageSpdxId = "SPDXRef-ContainerImage";
packages.push({
  name: image,
  SPDXID: imageSpdxId,
  versionInfo: imageId,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  licenseConcluded: "NOASSERTION",
  licenseDeclared: "NOASSERTION",
  copyrightText: "NOASSERTION",
});
relationships.push({
  spdxElementId: "SPDXRef-DOCUMENT",
  relationshipType: "DESCRIBES",
  relatedSpdxElement: imageSpdxId,
});

for (const item of osRows) {
  const SPDXID = `SPDXRef-deb-${safeId(`${item.name}-${item.version}-${item.arch}`)}`;
  const espeakFamily = new Set(["espeak-ng", "espeak-ng-data", "libespeak-ng1"]).has(item.name);
  packages.push({
    name: item.name,
    SPDXID,
    versionInfo: item.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: espeakFamily
      ? `See /usr/share/doc/${item.name}/copyright in the container image for complete file-level notices.`
      : "NOASSERTION",
    ...(espeakFamily ? {
      licenseComments:
        "Debian's eSpeak NG copyright metadata records GPL-3.0-or-later for the main upstream sources and separate file-level notices, including Apple and BSD terms. No single package-wide license conclusion is asserted here.",
    } : {}),
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:deb/debian/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}?arch=${encodeURIComponent(item.arch)}`,
    }],
  });
  relationships.push({ spdxElementId: imageSpdxId, relationshipType: "CONTAINS", relatedSpdxElement: SPDXID });
}

for (const item of npmRows) {
  const SPDXID = `SPDXRef-npm-${safeId(`${item.name}-${item.version}`)}`;
  packages.push({
    name: item.name,
    SPDXID,
    versionInfo: item.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [{
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:npm/${encodeURIComponent(item.name)}@${encodeURIComponent(item.version)}`,
    }],
  });
  relationships.push({ spdxElementId: imageSpdxId, relationshipType: "CONTAINS", relatedSpdxElement: SPDXID });
}

process.stdout.write(`${JSON.stringify({
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `apebooklm-${component}-${imageId.slice(7, 19)}`,
  documentNamespace: `https://apebooklm.example/sbom/${component}/${imageId.slice(7)}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: ApebookLM container SBOM generator 1.0"],
  },
  packages,
  relationships,
}, null, 2)}\n`);
