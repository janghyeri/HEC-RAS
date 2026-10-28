// 웹 자료 디코딩 점검 (PRD F-01 VALIDATION): 셀 찾기와 셀 값이 원자료와 맞는지 본다.
// 실행: web 폴더에서  npx tsx scripts/check-data.ts  [셀 중심 파일 경로]
//   셀 중심 파일(mesh_centers.i32)은 웹에 올리지 않으므로 data/out/<버전>/ 에서 읽는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CellIndex } from "../lib/cells";
import { cellResult, type Mesh, type Scenario } from "../lib/data";

const root = join(__dirname, "..", "public", "data");
const readJSON = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));
const readBin = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const index = readJSON("index.json");
const version: string = index.scenarios[0].model_version;
const info = readJSON(`${version}/mesh.json`);
const cells = new Float32Array(readBin(`${version}/mesh_cells.f32`));
const cellArea = new Float32Array(info.n_cells).map((_, i) => cells[2 * i]);
const mesh: Mesh = {
  info,
  vertices: new Int32Array(readBin(`${version}/mesh_vertices.i32`)),
  offsets: new Uint32Array(readBin(`${version}/mesh_offsets.u32`)),
  cellArea,
};

let t = Date.now();
const idx = new CellIndex(mesh);
console.log(`색인 ${Date.now() - t} ms, 셀 ${info.n_cells}`);

const centersPath = process.argv[2] ?? join(__dirname, "..", "..", "data", "out", version, "mesh_centers.i32");
const c = new Int32Array(readFileSync(centersPath).buffer.slice(0));
let ok = 0, miss = 0, other = 0;
t = Date.now();
for (let i = 0; i < info.n_cells; i++) {
  const f = idx.find(c[2 * i] / info.coordinate_scale, c[2 * i + 1] / info.coordinate_scale);
  if (f === i) ok++;
  else if (f === -1) miss++;
  else other++;
}
console.log(`셀 중심 → 셀 찾기: 일치 ${ok}, 못 찾음 ${miss}, 다른 셀 ${other} (${Date.now() - t} ms)`);
console.log(`범위 밖 점: ${idx.find(129.30, 35.90)}`);

for (const ref of index.scenarios) {
  const meta = readJSON(`${ref.path}/meta.json`);
  const kpi = readJSON(`${ref.path}/kpi.json`);
  const s = { ref, meta, kpi, cellsMax: new Uint8Array(readBin(`${ref.path}/cells_max.u8`)) } as unknown as Scenario;
  let wet = 0, wetArea = 0, maxD = 0;
  for (let i = 0; i < info.n_cells; i++) {
    const r = cellResult(s, mesh, i);
    if (r.maxDepth >= 0.1) {
      wet++;
      wetArea += r.area;
    }
    if (r.maxDepth > maxD) maxD = r.maxDepth;
  }
  console.log(`${ref.scenario_id}: 최대 수심 0.1 m 이상 셀 ${wet}개, 그 셀 면적 합 ${(wetArea / 1e6).toFixed(3)} km², 셀 최대 ${maxD.toFixed(2)} m`);
}
