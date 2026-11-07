# AGENTS.md

物理学の学習ロードマップを公開するドキュメントサイトの開発ガイドである。コーディングエージェントと人間の開発者の双方が従う。

## プロジェクト概要

- Astro と Starlight で構築した、物理学の学習ロードマップの静的サイトである。
- GitHub Pages へ自動デプロイする。公開 URL は`https://seijikohara.github.io/physics-roadmap`である。
- 数式・概念図・関数グラフ・データグラフを章中で表現できる。

## 第一言語は日本語

- 本リポジトリの第一言語は日本語とする。
- 章・ドキュメント・コミットメッセージ・PR・コードコメントを、原則として日本語で書く。
- サイトのコンテンツは日本語モノリンガルである（Starlight のルートロケール`lang: 'ja'`）。

## 技術スタック

- フレームワーク: Astro 7、Starlight 0.42
- UI アイランド: React 19
- 数式: remark-math、rehype-katex、KaTeX
  - KaTeX は版を固定する（`package.json`の`katex`に範囲指定を付けない）。図のラベルの幅を、KaTeX の内部 API が返す組版の木から見積もるためである。
  - 内部 API の木の形は版で変わりうる。KaTeX を上げるときは`pnpm run figures:widths`で見積もりの誤差を測り直してからマージする。
- 図・グラフ: visx（`@visx/*`）によるビルド時生成の静的 SVG。すべての図を visx で描く。
  - 座標・スケール: `@visx/scale`。描画: `@visx/shape`・`@visx/group`・`@visx/grid`・`@visx/marker`・`@visx/clip-path`。凡例: `@visx/legend`。
  - 概念図（フローチャート）: `@visx/network` ＋ `@dagrejs/dagre`（ビルド時のレイアウト）。`FlowChart`コンポーネントで描く。
  - 2D 図（関数・幾何・ベクトル・ベン図・数直線）: 各図コンポーネント（`FunctionGraph`・`UnitCircle`・`Triangle`・`NumberLine`・`VennDiagram`・`AreaModel`）。
  - データグラフ: visx を標準とする。高水準の図が要るときは`@visx/xychart`を導入する。データ図が必要な章で導入する。
- パッケージマネージャ: pnpm

## ディレクトリ構成

- `src/content/docs/`: 章（`.md`/`.mdx`）
- `src/components/`: React アイランドのコンポーネント
- `src/components/figure-label/`: 図のラベルの寸法・幾何・配置器の共通モジュール（DOM を使わない純粋な TypeScript）
  - `measure.ts`: KaTeX の組版の木から幅・高さを見積もる。`label-box.ts`: 基準点と寸法から字形の矩形を求める。
  - `obstacles.ts`・`candidates.ts`・`placer.ts`・`policy.ts`: 障害物・候補の生成器・配置器・罰点とすきまの定数。`ContourPlot`・`FunctionGraph`・`SurfacePlot`・`SpaceVectorDiagram`・`UnitCircle`・`Triangle`が使う。
- `src/styles/`: スタイル
- `.claude/agents/`: 執筆と検証のサブエージェント定義
- `docs/`: 設計と計画のドキュメント

## 開発コマンド

- `pnpm dev`: 開発サーバを起動する。
- `pnpm build`: 本番ビルドを生成する。
- `pnpm preview`: ビルド結果をプレビューする。
- `pnpm run lint`: JS/TS を oxlint で検証する（型認識・警告もエラー扱い）。
- `pnpm run lint:fix`: oxlint で自動修正できる箇所を修正する。
- `pnpm run format`: oxfmt でコードとドキュメントを整形する。
- `pnpm run format:check`: oxfmt で整形済みかを検査する。
- `pnpm run lint:text`: 全ドキュメントを textlint で校正する。
- `pnpm run lint:text:fix`: textlint で自動修正できる箇所を修正する。
- `pnpm run typecheck`: `astro sync`で Astro の型宣言を生成してから、TypeScript の型を`tsc --noEmit`で検査する。
- `pnpm run test`: Vitest で単体テスト（`src/**/*.test.ts`・`scripts/**/*.test.ts`）を実行する。
- `pnpm run check`: format:check・lint・typecheck・test・roadmap:check・roadmap:terms・lint:text をまとめて実行する。
- `pnpm run roadmap:check`: 設計書の前提の列と章のリンクの整合を検査する。
- `pnpm run roadmap:index`: 章ごとの推移的な上流の一覧`docs/roadmap/upstream-index.json`を作り直す。設計書の行を変えたら実行する。
- `pnpm run roadmap:paths -- <ID>...`: 行が推移的に必要とする行の数を、カテゴリごとに出す。
- `pnpm run roadmap:terms -- <章>...`: 章の本文が上流の外の語を使っていないかを調べ、本章で初出の LaTeX の命令を一覧にする。
  - `--all`で全章を集計する。`--file <パス> --as <章>`で、リポジトリの外の写しをその章として調べる。
  - 誤検出は`docs/roadmap/term-exceptions.json`に理由つきで置く。語の別の書き方も同じファイルの`aliases`に置く。
  - 章ごとの結果は検証者への入力である。`--all`は説明できない語が 1 件でもあると失敗する。`pnpm run check`と CI で実行する。
- `pnpm run figures:shot -- <ページ>...`: 章の図を 1 枚ずつ PNG に撮る（出力先は`.figures/shots`）。`figure`の外の図も撮る。
- `pnpm run figures:lint -- <ページ>...`: 図のラベルと線・点・他のラベルの重なりと近接を一覧にする（`--all`で全ページ）。
- `pnpm run figures:diff -- --base <基準の dist>`: 2 つのビルド結果を比べ、変わった図の前後を左右に並べた PNG を書き出す。
- `pnpm run figures:widths -- <labels.json>`: ラベルの幅の見積もり（`src/components/figure-label/`）と実測の誤差を、種類・部品ごとの表にする。

図のスクリプトは次のように使う。

- `<ページ>`には、ルート（`math/vector-calculus/curl`）・URL のパス・章ファイルのパスのどれでも渡せる。
- 既定の対象は dev サーバ（`http://localhost:4321/physics-roadmap`）である。`--dist dist`でビルド結果を対象にできる。
- ブラウザはインストール済みの Google Chrome を使う。出力先の`.figures/`は Git の管理外である。
- スクリプトは`scripts/figures/*.ts`（TypeScript）で、tsx で実行する。
- スクリプトも「コードの書き方」の節のイミュータビリティの規則に従う。
- `figures:lint`の近接（near）の閾値は既定で 4px である。4px は、ラベルと線のすきまの目標である。
- 図は 2 系列で数える。`figure`要素の番号（`図 3`）は章のキャプションと一致する。キャプションの無い`figure`の外の図は別の系列（`図 s1`、ファイル名は`fig-s01`）で数える。`figures:shot`の`--only`は`1,s2`の形で受ける。`figure`の外の図は SVG だけを扱うので、HTML の凡例は比べない。
- `figures:widths`の入力は`figures:lint`の`--labels`の出力である。`--worst <N>`で誤差の大きいラベルを出す。
  `pnpm run figures:lint -- --dist .figures/base --all --labels .figures/base-labels.json`
- 図の変更の前後比較は、次の順に行う。
  1. 変更前に`pnpm build`を実行し、`dist`を`.figures/base`へコピーする。既存の基準は置き換える。
     `rm -rf .figures/base && mkdir -p .figures && cp -R dist .figures/base`
  2. 基準の所見を JSON に書き出す（`pnpm run figures:lint -- --dist .figures/base --all --json .figures/base-lint.json`）。
  3. 変更後に`pnpm build`を実行する。
  4. `pnpm run figures:diff -- --base .figures/base`を実行し、`.figures/diff`の PNG を見る。
  5. `pnpm run figures:lint -- --dist dist --all --compare .figures/base-lint.json`を実行し、増えた所見と消えた所見を確かめる。
     `--fail-on overlap`を足すと、overlap・outside の所見が増えたときだけ終了コード 1 になる。

## 対象読者

- 本ロードマップが前提とする知識を持つ読者を対象とする。前提は最初の章[前提とする知識](src/content/docs/prerequisites/knowledge.mdx)に明記する。
- 標準模型のラグランジアンと一般相対性理論の数式理解を最終到達目標とする。経路は学部から大学院初年度の場の量子論と一般相対論に及ぶ。
- 前提と到達目標の差は章内で埋める。微積分・三角関数・ベクトルなど、前提とする知識に含まれない数学は、使う前に基礎から導入する。

## 学習ロードマップ

全体設計は`docs/roadmap-design.md`に定める。執筆の唯一の正とする。章は依存順に書く。

- **章の範囲**: 章に載せる話題は、設計書の行の「扱う内容」に合わせる。話題を足すときは、先に行を変える。
- **章の粒度**: 分割と統合は字数でなく内容で判断する。条件は設計書の「章の粒度」の節に定める。主題が 2 つあれば分割を検討し、片方に主定理が無いか内容が重複すれば統合を検討する。
- **自己完結**: 一連の章のみでゴールへ到達できる構成とする。説明の論理を外部資料に委ねない。「詳細は専門書を参照」と書かない。
- **参照は上流のみ（前方参照の禁止）**: 各章が参照・言及してよいのは、その章が推移的に依存する上流の章に限る。下流（その章から派生する後続）の章・未習の概念・後続のカテゴリ（未執筆の物理カテゴリを含む）へ言及しない。理由は自己完結である。読者がまだ学んでいない章・概念を前提や動機づけに持ち込むと、章単独で論理が閉じない。
  - 章末は章内で要点を振り返って閉じる。「次の章では〜」「後続の物理カテゴリで扱う」式の前方参照の文・節・リンクを置かない。
  - 動機づけは、特定の後続章を名指し・示唆しない一般的な記述にとどめる（例「運動の記述に使う」は可、「後の力学の章で運動方程式から導く」は不可）。
  - 同一章内の後方の節を指す「後述」、および章末「参考文献」は前方参照に当たらない。
- **演習による習得**: 各章に例題と演習問題を置く。演習には解答を付ける。
- **参考文献セクション**: さらに学ぶための一次資料・データ出典は、章末の独立した「参考文献」セクションに箇条書きでまとめる。参考文献は信頼できる一次資料に限る。
- **脚注の役割**: 脚注は本来の補足説明に充てる。記法の由来、暗黙の前提や成立条件、細かい例外、上位概念などを、厳選して置く。脚注も上流のみを参照し、下流の章・後続カテゴリへの布石にしない。脚注を読まなくても本文が完結するよう、論理の鎖の一部にはしない。

## ドキュメント執筆規約

日本語テクニカルライティングの文体に準拠する。`.textlintrc.json`の規則に通ることが必須要件である。

- 指示代名詞を使わない。「これ」「それ」「この」「その」などを避け、具体的な名詞で書く。
- 一文を短くする。一文一意とし、長い一文を避ける。一文は 120 文字以下を目安とする。
- 長い一文より Markdown 書式で読みやすくする。箇条書き・見出し・表・コードブロック・数式ブロックに分解する。
- 文体を統一する。である調とです・ます調を混在させない。
- 能動態・現在形を基本とし、主語を明示する。
- 略語と専門用語は初出時に定義する。
- 前提節には、設計書の前提の列にある直接の上流の章へのリンクを置く。間接の上流は挙げない。節名・例の番号・問題の番号・補題の名前・記号の一覧を書かない。本文で使う上流の概念と記号は、推移的な上流の章で導入済みであることを検証で確かめる。
- 記号・記法は初出で「読み方」「意味」「正式な記法か便宜的な書き方かの区別」を示し、定義より前に使わない（例: $\in$ は「に属する」、$\neq$ は「等しくない」、$\lvert x \rvert$ は「$x$ の絶対値」）。
- 主張に成立条件があるときは条件を明示し、過度に一般化しない。同値（iff）を主張するときは両方向を示すか、承認事項であると明示する。
- 読者向けの本文・図・脚注に、内部のカテゴリ識別子（`docs/roadmap-design.md`の`M-SET`・`M-SEQ`などの ID）を露出しない。カテゴリは日本語名（「数列と級数のカテゴリ」など）で呼ぶ。

## 表現手段

- 数式は KaTeX で書く。インラインは`$...$`、ブロックは`$$ ... $$`とする。
- すべての図・グラフは visx（`@visx/*`）でビルド時に静的 SVG を生成する。実装は`src/components/`にあり、クライアント JS を載せない。MDX から各コンポーネントを import して使う。
- 概念図（フローチャート）は`FlowChart`コンポーネントで描く。`@dagrejs/dagre`がビルド時にノード配置・エッジ経路・クラスタ境界を計算し、`@visx/network`で描く。ノード・エッジを宣言的な props で渡す。次の規約に従う。
  - ラベルは改行を`\n`、数式を`$...$`で表す（例: `"判別式 $D = b^2 - 4ac$\nを計算する"`）。数式部分は KaTeX で組版し、日本語の地の文は本文と同じシステムフォントで描く。数式でない語を`\text{}`で囲まない。
  - JSX の文字列リテラルでは LaTeX のバックスラッシュを 2 重にする（`\gt`は`"\\gt"`、`\mathbb{R}`は`"\\mathbb{R}"`）。不等号は`\lt`・`\gt`で書く。
  - 形状は`shape: "diamond"`で菱形（判断）、既定は矩形。エッジは`dashed: true`で破線。サブグラフは`clusters`（入れ子可）で表す。方向は`direction: "TB" | "LR"`。
  - ラベルの寸法は`figure-label/measure.ts`で見積もる。寸法が変わると dagre の配置全体が動くので、ラベルの文言を変えた図は目で確かめる。
  - 図の幅が本文の列より広いと縮小して表示され、字も小さくなる。方向を変える、ラベルを`\n`で折り返す、などで幅を抑える。
- 2D 図（関数グラフ・幾何・ベクトル・ベン図・数直線）は、対応する各コンポーネント（`FunctionGraph`・`UnitCircle`・`Triangle`・`NumberLine`・`VennDiagram`・`AreaModel`）で描く。
  - 図中ラベルの数式は`KatexLabel`が SVG の foreignObject に KaTeX を埋め込む。根号などの伸縮グリフは foreignObject 内で高さ 0 に潰れるため、`src/styles/global.css`で各図の`.katex svg`に`height: 100%`を与えて復元している。新たな伸縮グリフを使うときは、ビルドして実機で確認する。
  - 図中の日本語は本文と同じシステムフォントにそろえる（`global.css`で KaTeX の`.cjk_fallback`を本文フォントへ上書き済み）。各図は表示倍率 1.0（`max-width`＝viewBox 幅）で描き、フォントサイズを図をまたいでそろえる。
- `ContourPlot`のラベルは配置器が置く。ラベルと線・点の印のすきまの目標は 4px である。等高線の隣のレベルの線は例外で、字形に重なる部分だけを切るので、字形へ 4px より近づくことがある。ラベルは`contours`と`levels`の並びの順に置き、後のラベルが先のラベルを避けるので、配置はレベルの順序に依存する。次の指定で位置を調整する。
  - `labelAt`は基準点である。矢印・線分・領域・等高線のレベルは数学座標で渡し、等高線のレベルでは線の上の最寄りの点へ吸着させる。曲線・媒介変数曲線は線の上の点を x または媒介変数で渡す。
  - `labelDir`は基準点から見た向きで、`"auto"`・`"center"`・8 方位を渡す。`labelAt`だけなら基準点を固定して向きを自動で選び、`labelAt`と`labelDir`の両方があれば完全に固定する。曲線・媒介変数曲線の`labelAt`だけの指定では、線の進む向きの右側を優先し、右側の罰点が反対側を`fixedSide`（2.5）より大きく上回るときだけ反対側へ移す。
  - 矢印・線分は、`labelAt`があるときの`labelDir`の既定が`"center"`である。`labelAt`の点をラベルの中心にする。向きを自動で選ぶには`labelDir: "auto"`を渡す。
  - `labelOffset`は線や基準点と字形のすきまの目標（px）で、既定は 4 である。箱は見積もりの誤差の分だけさらに離すので、箱の縁までは基準点・点の印から`labelOffset + 1`、線の中心から`labelOffset + 2.25`（向きを固定したときは`labelOffset + 2`）である。
- `FunctionGraph`のラベルも配置器が置く。ラベルは補助線分・ベクトル・点・補助線（漸近線）の順に置き、後のラベルが先のラベルを避けるので、配置は要素の順序に依存する。次の指定で位置を調整する。
  - 点・補助線分・ベクトル・補助線は`labelAt`・`labelDir`・`labelOffset`を受ける。意味は`ContourPlot`の矢印・線分と同じで、`labelAt`があるときの`labelDir`の既定は`"center"`である。
  - 点のラベルは、自動で置くと点のまわりの 3 重の輪から位置を選ぶので、点から離れることがある。点の近くに固定するときは`labelDir`を渡す。
- `UnitCircle`のラベルは先端の座標・余弦・角・正弦の順に、`Triangle`のラベルは頂点・足・辺・高さ・角の順に、配置器が置く。`Triangle`の頂点と辺は`labelDir`・`labelOffset`を受ける。`NumberLine`・`AreaModel`は位置が決まっているので配置器を使わず、字形の寸法から少なくとも 4px のすきまを取る。行のラベルは基線をそろえる。
- `ContourPlot`の曲線の`labelPlacement`は、線のそばに置く`"inline"`と凡例に載せる`"legend"`を選ぶ指定である。
- `SurfacePlot`・`SpaceVectorDiagram`のラベルも配置器が置く。ラベルは曲面・平面・領域・曲線・線分・点の順（`SpaceVectorDiagram`は平行四辺形・ベクトル・点の順）に置き、後のラベルが先のラベルを避ける。次の指定で位置を調整する。
  - `labelDir`は基準点から見た画面の上の向きである。空間の向きではない。`labelOffset`の意味は 2 次元の図と同じである。
  - 点・線分・ベクトルの`labelAt`は空間の点で、`labelAt`があるときの`labelDir`の既定は`"center"`である。曲面・平面・平行四辺形の`labelAt`も空間の点だが、向きの指定が無ければ基準点とそのまわりから自動で選ぶ。領域の`labelAt`は面の上の`x`・`y`である。曲線の`labelAt`は媒介変数である。
  - 面の上の点のラベルは網目に重なることがある。網目を強く避けると点から離れるためである。軸・曲線・線分・落とし込み線・床グリッドのうち、面に隠れて淡く描く区間の罰点は見える度合いのぶんだけ軽く、描かない区間は数えない。面の縁・網目・ベクトル場は隠れを見ない。
- ドラッグやスライダーなど双方向性が必要な図のみ、クライアントアイランドで読み込む。
- データグラフは visx を標準とする。高水準の図が要るときは`@visx/xychart`を導入する。データ図が必要な章で導入する。双方向性が要る場合は、その時点で描画手段を選定する。

## コードの書き方

- コードは TypeScript で書き、JS ファイルを置かない。
- イミュータビリティを基本にする。
  - 変数は`const`だけを使う。
  - 型は`readonly`を基本にする（`readonly T[]`・`Readonly<...>`・`ReadonlyMap`・`as const`）。
  - 配列とオブジェクトをその場で書き換えない。`push`・`splice`・`sort`・添字への代入の代わりに、`map`・`filter`・`reduce`・`toSorted`・スプレッドで新しく作る。
- 例外として、関数の中に閉じた局所の可変バッファを許す。理由をコメントに書き、可変の値を関数の外へ出さない。
  - 作り直すと遅くなる重い計算（等高線の追跡など）
  - 可変の API しか持たないライブラリ（dagre など）
- `src/components/**`・`scripts/**`・`astro.config.ts`には、`.oxlintrc.json`の overrides で次の規則をかける。
  - `no-param-reassign`（引数の書き換えの禁止）
  - `prefer-readonly-parameter-types`（読み取り専用の引数の型）
  - その場の`sort`・`reverse`の禁止

## 品質ゲート

- コミット前に lefthook の pre-commit フックが、oxfmt（整形）→ oxlint（型認識・警告もエラー扱い）→ textlint（校正）を順に実行する。エラーがあればコミットを中断する。
- CI（GitHub Actions）の lint ワークフローでも、oxfmt の整形検査・oxlint・tsc の型検査・Vitest の単体テスト・設計書と章の整合の検査・textlint を実行する。エラーがあればチェックを失敗させる。
- フックは`pnpm install`時の`prepare`スクリプト（`lefthook install`）で有効化する。

## コミット規約

- Conventional Commits 形式で書く。
- description は命令形・現在形で簡潔に書く。
- body には「何を」「なぜ」変更したかを書く。
- 本文は日本語で書く。
- Claude の署名や帰属テキストを付与しない。

## サブエージェント

`.claude/agents/`に執筆と検証のサブエージェントを定義する。

- `chapter-writer`: 解説の章を執筆する。最終化の前に必ず 4 つの検証を通す。
- `math-verifier`: 数式・導出・単位・係数の正しさを検証する。
- `logic-leap-verifier`: 論理の飛躍・暗黙の前提・根拠のない結論、および記号・記法の初出の導入を検証する。
- `visual-verifier`: 視覚表現（図・ダイアグラム・グラフ）が十分か、可視化方針に沿うかを検証する。
- `markdown-verifier`: Markdown 書式の活用（構造化・見出し・表・数式の使い分け）が十分かを検証する。

章を書くときは`chapter-writer`を使う。`chapter-writer`が 4 つの検証サブエージェントを呼ぶ。
