import { Mafs, Coordinates, Plot, Vector, useMovablePoint } from 'mafs';

// Vector field with a draggable point. `useMovablePoint` returns the current
// position (`.point`) and the draggable handle element (`.element`).
export default function VectorFieldPlot(): React.JSX.Element {
  const point = useMovablePoint([2, 1]);

  return (
    <Mafs height={400}>
      <Coordinates.Cartesian />
      <Plot.VectorField xy={([x, y]) => [y, -x]} step={1} />
      <Vector tip={point.point} />
      {point.element}
    </Mafs>
  );
}
