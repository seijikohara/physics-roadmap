/**
 * 3 次元の図コンポーネントが共有する正投影（軸測投影）。
 *
 * 空間の右手系の座標 (x, y, z) を、SVG の画面座標 (sx, sy) へ線形に写す。視点は方位角
 * （鉛直軸まわりの回転）と仰角（見下ろし角）で決める。既定の視点（方位角 35°・仰角 30°）
 * では、$x$ 軸が左手前、$y$ 軸が右奥、$z$ 軸が上を向く。$y$ 軸を真横に寝かせる斜投影だと
 * 床面（$xy$ 平面）が線分に潰れて立体に見えない。そこで $x$・$y$ の両軸に下向きの傾きを
 * 与え、$xy$ 平面が「奥へ広がる床」に見える視点を取る。
 *
 * 写像は次の 3 段で組み立てる。段を分けるのは、図ごとに描画領域の寸法と余白の決め方が
 * 異なっても、同じ投影を共有するためである。
 * 1. `viewBasis`: 視点から、各軸の単位ベクトルを写す画面上の向きと、視線方向を求める。
 * 2. `projectedBounds`・`fitView`: 図に現れる点の投影範囲から、描画領域に収まる最大倍率と
 *    中央寄せの原点を決める。
 * 3. `makeProjector`: 倍率と原点を織り込んだ写像 `project` と、奥行き `depth` を返す。
 *
 * 奥行き `depth` は視線方向（画面の手前向き）への座標である。値が大きいほど視点に近い。
 * 面を奥から手前へ重ねる画家のアルゴリズムでは、`depth` の昇順に描く。
 *
 * 浮動小数点の演算順は SpaceVectorDiagram の切り出し前の計算と完全に一致させている。
 * 既存の図の SVG 出力を 1 文字も変えないためである。式を整理（因数のくくり出しなど）すると
 * 丸め誤差が変わり、座標の末尾の桁がずれるので、演算順を変えないこと。
 */

/** 空間の点（またはベクトル）。 */
export type Vec3 = { x: number; y: number; z: number };

/** 画面上の点（またはベクトル）。SVG と同じく下向きが正の sy を持つ。 */
export type ScreenPoint = { sx: number; sy: number };

/** 視点が決める投影の基底。各軸の単位ベクトルの画面上の向きと、視線方向を持つ。 */
export type ViewBasis = {
  /** $x$ 軸の単位ベクトルを写す画面ベクトル（倍率 1）。 */
  dirX: ScreenPoint;
  /** $y$ 軸の単位ベクトルを写す画面ベクトル（倍率 1）。 */
  dirY: ScreenPoint;
  /** $z$ 軸の単位ベクトルを写す画面ベクトル（倍率 1）。 */
  dirZ: ScreenPoint;
  /** 視線方向（画面の手前向き）の空間の単位ベクトル。奥行きの計算に使う。 */
  fwd: Vec3;
};

/** 投影範囲（倍率 1 の画面座標での最小・最大）。 */
export type ScreenBounds = { minSx: number; maxSx: number; minSy: number; maxSy: number };

/** 描画領域への当てはめ。倍率と、空間の原点を写す画面座標を持つ。 */
export type ViewFit = { scale: number; originX: number; originY: number };

/** 既定の方位角（度）。35° は床面が十分開いて見え、3 軸の成分も読み取りやすい。 */
export const DEFAULT_AZIMUTH_DEG = 35;

/** 既定の仰角（度）。30° と方位角 35° の組がダイメトリック（2 軸の縮み率が等しくない）を作る。 */
export const DEFAULT_ELEVATION_DEG = 30;

/** 度をラジアンへ換算する。 */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * 方位角 azimuth・仰角 elevation（いずれもラジアン）の視点が決める投影の基底を返す。
 *
 * SVG は下向きが正のため、上向きの $z$ 軸は画面の負の sy へ向ける。$x$ は左手前（左・下）、
 * $y$ は右奥（右・下、$x$ より浅い）へ退かせ、$xy$ 平面を床として見せる。視線方向 fwd は
 * 画面の右向きと上向きの外積で、右手系を保つ（鏡像にならない）。
 */
export function viewBasis(azimuth: number, elevation: number): ViewBasis {
  const sinT = Math.sin(azimuth);
  const cosT = Math.cos(azimuth);
  const sinP = Math.sin(elevation);
  const cosP = Math.cos(elevation);
  return {
    dirX: { sx: -sinT, sy: cosT * sinP }, // x 軸: 左手前。
    dirY: { sx: cosT, sy: sinT * sinP }, // y 軸: 右奥。
    dirZ: { sx: 0, sy: -cosP }, // z 軸: 上。
    fwd: { x: cosT * cosP, y: sinT * cosP, z: sinP },
  };
}

/** 既定の視点（方位角 35°・仰角 30°）の投影の基底。 */
export const DEFAULT_VIEW: ViewBasis = viewBasis(
  degToRad(DEFAULT_AZIMUTH_DEG),
  degToRad(DEFAULT_ELEVATION_DEG),
);

/** 空間の点の列を倍率 1・原点 (0, 0) で投影し、画面上の範囲を返す。 */
export function projectedBounds(points: Vec3[], basis: ViewBasis): ScreenBounds {
  const { dirX, dirY, dirZ } = basis;
  const raw = points.map((p) => ({
    sx: p.x * dirX.sx + p.y * dirY.sx + p.z * dirZ.sx,
    sy: p.x * dirX.sy + p.y * dirY.sy + p.z * dirZ.sy,
  }));
  return {
    minSx: Math.min(...raw.map((c) => c.sx)),
    maxSx: Math.max(...raw.map((c) => c.sx)),
    minSy: Math.min(...raw.map((c) => c.sy)),
    maxSy: Math.max(...raw.map((c) => c.sy)),
  };
}

/**
 * 投影範囲 bounds を、幅 width・高さ height の描画領域から四辺の余白 margin を引いた枠へ
 * 収める最大倍率と、投影範囲を枠の中央へ寄せる原点を返す。
 */
export function fitView(
  bounds: ScreenBounds,
  width: number,
  height: number,
  margin: number,
): ViewFit {
  const { minSx, maxSx, minSy, maxSy } = bounds;
  // 範囲が 0（点が 1 つだけなど）のときは 1 とみなし、0 除算を避ける。
  const spanX = maxSx - minSx || 1;
  const spanY = maxSy - minSy || 1;
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  return {
    scale,
    originX: (width - (minSx + maxSx) * scale) / 2,
    originY: (height - (minSy + maxSy) * scale) / 2,
  };
}

/** 倍率と原点を織り込んだ写像 project と、奥行き depth を返す。 */
export function makeProjector(
  basis: ViewBasis,
  fit: ViewFit,
): { project: (p: Vec3) => ScreenPoint; depth: (p: Vec3) => number } {
  const { dirX, dirY, dirZ, fwd } = basis;
  const { scale, originX, originY } = fit;
  // 倍率を先に掛けた画面ベクトル。演算順を切り出し前の計算と一致させる（ファイル冒頭を参照）。
  const ex = { sx: dirX.sx * scale, sy: dirX.sy * scale };
  const ey = { sx: dirY.sx * scale, sy: dirY.sy * scale };
  const ez = { sx: dirZ.sx * scale, sy: dirZ.sy * scale };
  return {
    project: (p) => ({
      sx: originX + p.x * ex.sx + p.y * ey.sx + p.z * ez.sx,
      sy: originY + p.x * ex.sy + p.y * ey.sy + p.z * ez.sy,
    }),
    depth: (p) => p.x * fwd.x + p.y * fwd.y + p.z * fwd.z,
  };
}
