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
}

export default function DataChart({ type, data, options }: DataChartProps): React.JSX.Element {
  if (type === 'bar') {
    return <Bar data={data as never} options={options as never} />;
  }
  if (type === 'scatter') {
    return <Scatter data={data as never} options={options as never} />;
  }
  return <Line data={data as never} options={options as never} />;
}
