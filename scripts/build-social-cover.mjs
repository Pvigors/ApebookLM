#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = async (name) => "data:image/png;base64," + (await fs.readFile(path.join(root, name))).toString("base64");
const logo = await image("public/brand/yuanbiji-head.png");
const screen = await image("docs/images/workspace.png");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="640" viewBox="0 0 1280 640">
<defs>
 <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#FAF9FF"/><stop offset="1" stop-color="#EFEAFE"/></linearGradient>
 <clipPath id="screen"><rect x="592" y="114" width="622" height="390" rx="18"/></clipPath>
</defs>
<rect width="1280" height="640" fill="url(#paper)"/>
<circle cx="1250" cy="15" r="285" fill="#E7E1FC"/>
<circle cx="1180" cy="64" r="202" fill="#F5F2FF"/>
<image x="64" y="55" width="62" height="63" href="${logo}"/>
<text x="145" y="98" fill="#262332" font-family="Arial,Helvetica,sans-serif" font-size="32" font-weight="700">ApebookLM</text>
<text x="65" y="187" fill="#6755E8" font-family="Arial,Helvetica,sans-serif" font-size="15" font-weight="700" letter-spacing="3">OPEN SOURCE · SELF HOSTED</text>
<g fill="#262332" font-family="Arial,Helvetica,sans-serif" font-size="53" font-weight="700" letter-spacing="-1.7">
 <text x="61" y="268">Your sources.</text><text x="61" y="334">Answers you</text><text x="61" y="400">can trace.</text>
</g>
<text x="64" y="459" fill="#605B70" font-family="Arial,Helvetica,sans-serif" font-size="22">Research, create, and export.</text>
<rect x="592" y="114" width="622" height="390" rx="18" fill="#FFFFFF" stroke="#DAD3F6" stroke-width="2"/>
<image x="592" y="114" width="622" height="390" href="${screen}" clip-path="url(#screen)"/>
<rect x="66" y="520" width="101" height="34" rx="17" fill="#E8E2FA"/><text x="89" y="543" fill="#5040BE" font-family="Arial,sans-serif" font-size="16" font-weight="600">BYOK</text>
<rect x="178" y="520" width="110" height="34" rx="17" fill="#E8E2FA"/><text x="199" y="543" fill="#5040BE" font-family="Arial,sans-serif" font-size="16" font-weight="600">Docker</text>
<rect x="299" y="520" width="182" height="34" rx="17" fill="#E8E2FA"/><text x="319" y="543" fill="#5040BE" font-family="Arial,sans-serif" font-size="16" font-weight="600">CAD / STEP export</text>
<line x1="64" y1="588" x2="1214" y2="588" stroke="#DAD3F6"/>
<text x="64" y="621" fill="#625B72" font-family="Arial,sans-serif" font-size="17">github.com/Pvigors/ApebookLM</text>
<text x="1214" y="621" text-anchor="end" fill="#625B72" font-family="Arial,sans-serif" font-size="15">AGPL-3.0-only</text>
</svg>`;
const output = path.join(root, "docs/images/social-preview.png");
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(output);
const meta = await sharp(output).metadata();
console.log(JSON.stringify({ output: "docs/images/social-preview.png", width: meta.width, height: meta.height, bytes: (await fs.stat(output)).size }));
