import { scaleLinear } from "@visx/scale";
import { Circle, Line, Polygon } from "@visx/shape";
import KatexLabel from "./KatexLabel";

/**
 * インライン SVG として描く、ビルド時生成の静的な図。
 *
 * 単位円上の扇形 OAP を、内接する三角形 OAP（弦 AP で囲む）と外接する三角形 OAT（点 A
 * を通る垂線 AT で囲む）ではさんで描く。中心角 x（$0 \lt x \lt 90^\circ$）に対する
 * $\sin x \lt x \lt \tan x$ の証明で、3 つの面積の大小を目で追うための図である。3 つの
 * 領域を異なる色の半透明な塗りで重ね、内側から外側へ「三角形 OAP ⊂ 扇形 OAP ⊂ 三角形
 * OAT」という包含関係を示す。点 T は、動径 OP を延長して $x$ 座標が $1$ になる点として
 * 座標だけから定める（円の接線という概念を経由しない）。本コンポーネントはクライアント
 * JavaScript を一切載せない。Astro がビルド時に HTML へ描画する（クライアントディレク
 * ティブなし、ハイドレーションなし）。横縦で同じ倍率にし、形を歪めない。ラベルは
 * KatexLabel を介して KaTeX で組版する。
 */

type Pt = { x: number; y: number };

type SectorComparisonProps = {
  /** 中心角（度）。$0 \lt \text{angleDeg} \lt 90$ を想定する。 */
  angleDeg: number;
  /** 中心 O に添える LaTeX ラベル。既定 "\\mathrm{O}"。 */
  centerLabel?: string;
  /** 基準点 A=(1,0) に添える LaTeX ラベル。既定 "\\mathrm{A}"。 */
  baseLabel?: string;
  /** 弧上の点 P=(\cos x,\sin x) に添える LaTeX ラベル。既定 "\\mathrm{P}"。 */
  apexLabel?: string;
  /** 延長線上の点 T=(1,\tan x) に添える LaTeX ラベル。既定 "\\mathrm{T}"。 */
  tangentPointLabel?: string;
  /** 中心角に添える LaTeX ラベル。既定 "x"。 */
  angleLabel?: string;
  /** 線分 AT の長さに添える LaTeX ラベル。既定 "\\tan x"。 */
  tangentLengthLabel?: string;
  /** 支援技術が読み上げるアクセシブルな説明。 */
  ariaLabel: string;
};

// 塗りは領域ごとに色を変え、暗テーマでも重なりが判別できるようにする（不透明度は固定）。
const OUTER = "#f59e0b"; // 三角形 OAT（面積 (1/2) tan x）。
const SECTOR = "#3b82f6"; // 扇形 OAP（面積 (1/2) x）。弧・半径もこの色でそろえる。
const INNER = "#10b981"; // 三角形 OAP（面積 (1/2) sin x）。弦もこの色でそろえる。
const MARK = "var(--fig-axis)";
const DOT = "#3b82f6";

const VIEW = 300;
const PAD = 40;

export default function SectorComparison({
  angleDeg,
  centerLabel = "\\mathrm{O}",
  baseLabel = "\\mathrm{A}",
  apexLabel = "\\mathrm{P}",
  tangentPointLabel = "\\mathrm{T}",
  angleLabel = "x",
  tangentLengthLabel = "\\tan x",
  ariaLabel,
}: SectorComparisonProps) {
  const theta = (angleDeg * Math.PI) / 180;
  const O: Pt = { x: 0, y: 0 };
  const A: Pt = { x: 1, y: 0 };
  const P: Pt = { x: Math.cos(theta), y: Math.sin(theta) };
  const T: Pt = { x: 1, y: Math.tan(theta) };

  // 4 点が収まる範囲に、点・ラベル用の余白を加えて縮尺を決める。横縦で同じ倍率にする。
  const minX = -0.3;
  const maxX = Math.max(A.x, P.x, T.x) + 0.32;
  const minY = -0.24;
  const maxY = Math.max(P.y, T.y) + 0.3;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const availW = VIEW - 2 * PAD;
  const availH = VIEW - 2 * PAD;
  const unit = Math.min(availW / spanX, availH / spanY);
  const boxW = unit * spanX;
  const boxH = unit * spanY;
  const offX = PAD + (availW - boxW) / 2;
  const offY = PAD + (availH - boxH) / 2;

  const sx = scaleLinear<number>({ domain: [minX, maxX], range: [offX, offX + boxW] });
  const sy = scaleLinear<number>({ domain: [minY, maxY], range: [offY + boxH, offY] });
  const S = (p: Pt): Pt => ({ x: sx(p.x), y: sy(p.y) });

  const So = S(O);
  const Sa = S(A);
  const Sp = S(P);
  const St = S(T);
  const r = sx(1) - sx(0);

  // 扇形の塗り（O→A→弧→P→閉じる）。0 < angleDeg < 90 を想定するため、常に短い方の弧を
  // 取る（largeArc=0）。角の向きは正（反時計回り）を想定する（sweep=0）。
  const sectorPath = `M ${So.x} ${So.y} L ${Sa.x} ${Sa.y} A ${r} ${r} 0 0 0 ${Sp.x} ${Sp.y} Z`;
  const arcPath = `M ${Sa.x} ${Sa.y} A ${r} ${r} 0 0 0 ${Sp.x} ${Sp.y}`;

  // 点 A での直角の印。辺 AO・辺 AT に沿う 2 方向へ小さな正方形を作る。
  const dAO = unitVec(Sa, So);
  const dAT = unitVec(Sa, St);
  const rs = 11;
  const rc1 = { x: Sa.x + dAO.x * rs, y: Sa.y + dAO.y * rs };
  const rc2 = { x: Sa.x + dAT.x * rs, y: Sa.y + dAT.y * rs };
  const rc3 = { x: rc1.x + dAT.x * rs, y: rc1.y + dAT.y * rs };

  // 弦 AP の描き始めの点。直角の印（一辺 rs の正方形、対角線の長さは rs*√2）の外側から
  // 弦を描き、印の内部を斜めに横切らないようにする。
  const dAP = unitVec(Sa, Sp);
  const chordStart = { x: Sa.x + dAP.x * rs * 1.5, y: Sa.y + dAP.y * rs * 1.5 };

  // 点 P のラベル位置。動径 OP の方向と同じ向き（またはその逆向き）へラベルを置くと、
  // 半径の延長線 PT（P から T へ同じ向きに伸びる破線）とラベルの文字が接近しすぎる。
  // OP に垂直な向きへラベルを離し、延長線からも弧からも離す。
  const opDir = unitVec(So, Sp);
  const apexLabelDir = { x: opDir.y, y: -opDir.x };

  // 点 O での角 x の弧とラベル位置。
  const angleArcR = Math.min(r * 0.32, 26);
  const angleArcEnd = {
    x: So.x + angleArcR * Math.cos(theta),
    y: So.y - angleArcR * Math.sin(theta),
  };
  const angleMid = theta / 2;

  return (
    <svg
      className="sector-comparison"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* 外側の三角形 OAT（塗りのみ）。面積は (1/2) tan x。不透明度は CSS 変数で切り替え、
          暗テーマでも最下層（この層だけの領域）が背景から浮かび上がるようにする
          （src/styles/global.css の --sector-outer-fill-opacity を参照）。 */}
      <Polygon
        points={[
          [So.x, So.y],
          [Sa.x, Sa.y],
          [St.x, St.y],
        ]}
        className="sector-comparison-outer"
        fill={OUTER}
        stroke="none"
      />

      {/* 扇形 OAP（塗りのみ）。面積は (1/2) x。 */}
      <path className="sector-comparison-sector" d={sectorPath} fill={SECTOR} stroke="none" />

      {/* 内側の三角形 OAP（塗りのみ）。面積は (1/2) sin x。 */}
      <Polygon
        points={[
          [So.x, So.y],
          [Sa.x, Sa.y],
          [Sp.x, Sp.y],
        ]}
        className="sector-comparison-inner"
        fill={INNER}
        stroke="none"
      />

      {/* 基準線分 OA。 */}
      <Line from={So} to={Sa} stroke={MARK} strokeWidth={1.4} />
      <KatexLabel tex="1" x={(So.x + Sa.x) / 2} y={So.y + 14} fontSize={12} />

      {/* 半径 OP。 */}
      <Line from={So} to={Sp} stroke={SECTOR} strokeWidth={2} />

      {/* 半径の延長 PT（円の外側の部分。動径を x 座標が 1 になるまで延ばした線分）。 */}
      <Line from={Sp} to={St} stroke={SECTOR} strokeWidth={1.3} strokeDasharray="4 3" />

      {/* 弧 AP（扇形の曲線の境界）。 */}
      <path d={arcPath} fill="none" stroke={SECTOR} strokeWidth={2} />

      {/* 線分 AT。長さが tan x である。 */}
      <Line from={Sa} to={St} stroke={OUTER} strokeWidth={2} />
      <KatexLabel
        tex={tangentLengthLabel}
        x={St.x + 15}
        y={(Sa.y + St.y) / 2}
        fontSize={12}
        align="left"
      />

      {/* 弦 AP（三角形 OAP の斜辺）。点 A での直角の印と重ならないよう、A から少し離した
          位置から描き始める。 */}
      <Line from={chordStart} to={Sp} stroke={INNER} strokeWidth={1.3} strokeDasharray="4 3" />

      {/* 点 A での直角の印。 */}
      <polyline
        points={`${rc1.x},${rc1.y} ${rc3.x},${rc3.y} ${rc2.x},${rc2.y}`}
        fill="none"
        stroke={MARK}
        strokeWidth={1.2}
      />

      {/* 点 O での角 x の弧とラベル。 */}
      <path
        d={`M ${So.x + angleArcR} ${So.y} A ${angleArcR} ${angleArcR} 0 0 0 ${angleArcEnd.x} ${angleArcEnd.y}`}
        fill="none"
        stroke={SECTOR}
        strokeWidth={1.3}
      />
      <KatexLabel
        tex={angleLabel}
        x={So.x + angleArcR * 1.8 * Math.cos(angleMid)}
        y={So.y - angleArcR * 1.8 * Math.sin(angleMid)}
        fontSize={12}
      />

      {/* 頂点の点とラベル。 */}
      <Circle cx={So.x} cy={So.y} r={3.2} fill={DOT} />
      <KatexLabel tex={centerLabel} x={So.x - 15} y={So.y + 12} fontSize={13} />

      <Circle cx={Sa.x} cy={Sa.y} r={3.2} fill={DOT} />
      <KatexLabel tex={baseLabel} x={Sa.x + 3} y={Sa.y + 15} fontSize={13} />

      <Circle cx={Sp.x} cy={Sp.y} r={3.2} fill={DOT} />
      <KatexLabel
        tex={apexLabel}
        x={Sp.x + apexLabelDir.x * 20}
        y={Sp.y + apexLabelDir.y * 20}
        fontSize={13}
      />

      <Circle cx={St.x} cy={St.y} r={3.2} fill={DOT} />
      <KatexLabel tex={tangentPointLabel} x={St.x + 17} y={St.y - 7} fontSize={13} />
    </svg>
  );
}

/** a から b へ向かう単位ベクトル（SVG 座標）。 */
function unitVec(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
