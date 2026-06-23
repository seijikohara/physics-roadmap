import { Mafs, Coordinates, Plot } from 'mafs';

// Static function plot template. Island props cannot be functions, so the
// plotted function lives here. Copy this file and edit `f` for a new plot.
const f = (x: number): number => Math.sin(x);

export default function FunctionPlot(): React.JSX.Element {
  return (
    <Mafs height={400}>
      <Coordinates.Cartesian />
      <Plot.OfX y={f} />
    </Mafs>
  );
}
