import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line, Bar, Scatter } from 'react-chartjs-2';

// Register the Chart.js pieces used by line/bar/scatter charts once.
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
);

interface DataChartProps {
  type: 'line' | 'bar' | 'scatter';
  // Chart.js data/options are plain objects, so they cross the island boundary.
  data: object;
  options?: object;
  // Container height in pixels. Chart.js fills the sized wrapper below.
  height?: number;
}

export default function DataChart({
  type,
  data,
  options,
  height = 400,
}: DataChartProps): React.JSX.Element {
  // The astro-island wrapper uses `display: contents`, which has no box, so
  // Chart.js cannot read a size from it. Wrap the chart in a sized, relatively
  // positioned container and disable the aspect ratio so it fills that box.
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    ...options,
  };

  const chart =
    type === 'bar' ? (
      <Bar data={data as never} options={chartOptions as never} />
    ) : type === 'scatter' ? (
      <Scatter data={data as never} options={chartOptions as never} />
    ) : (
      <Line data={data as never} options={chartOptions as never} />
    );

  return <div style={{ position: 'relative', height: `${height}px` }}>{chart}</div>;
}
