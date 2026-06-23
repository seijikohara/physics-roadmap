import { useState } from 'react';
import { Mafs, Coordinates, Plot } from 'mafs';

// Mafs has no built-in slider, so use a plain range input + React state and
// feed the value into the plotted function.
export default function InteractivePlot(): React.JSX.Element {
  const [amplitude, setAmplitude] = useState(1);

  return (
    <div>
      <label>
        振幅: {amplitude.toFixed(1)}{' '}
        <input
          type="range"
          min={0}
          max={3}
          step={0.1}
          value={amplitude}
          onChange={(event) => setAmplitude(Number(event.target.value))}
        />
      </label>
      <Mafs height={400}>
        <Coordinates.Cartesian />
        <Plot.OfX y={(x) => amplitude * Math.sin(x)} />
      </Mafs>
    </div>
  );
}
