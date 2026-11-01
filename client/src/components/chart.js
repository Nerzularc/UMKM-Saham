/**
 * Chart component using Chart.js.
 * All charts are clearly labelled as DEMO DATA when prices are simulated.
 */
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale,
         BarController, BarElement, ArcElement, DoughnutController, Title, Tooltip, Legend, Filler
} from 'chart.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale,
               BarController, BarElement, ArcElement, DoughnutController, Title, Tooltip, Legend, Filler);

const CHART_DEFAULTS = {
  color: '#94a3b8',
  borderColor: '#1e293b',
  backgroundColor: 'rgba(59,130,246,0.08)',
  font: { family: '-apple-system, "Segoe UI", sans-serif', size: 11 },
};

Chart.defaults.color             = CHART_DEFAULTS.color;
Chart.defaults.borderColor       = '#1e293b';
Chart.defaults.font.family       = CHART_DEFAULTS.font.family;
Chart.defaults.font.size         = CHART_DEFAULTS.font.size;
Chart.defaults.plugins.legend.labels.color = '#94a3b8';

const activeCharts = new Map();

/** Compact axis labels: 1.5 jt / 2.3 M (id) — plain numbers below 1,000. */
function compactTick(v) {
  const n = Number(v); const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(1)} T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)} M`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)} jt`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)} rb`;
  return n.toLocaleString();
}
const PALETTE = ['#3b82f6', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

export function renderChart(canvasId, config, isDemo = true) {
  // Destroy previous chart on same canvas
  if (activeCharts.has(canvasId)) {
    activeCharts.get(canvasId).destroy();
    activeCharts.delete(canvasId);
  }

  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const ctx = canvas.getContext('2d');

  // Add demo watermark if demo data
  if (isDemo) {
    const wrapper = canvas.parentElement;
    const existing = wrapper.querySelector('.chart-demo-label');
    if (!existing) {
      const label = document.createElement('div');
      label.className = 'chart-demo-label absolute top-1 right-2 text-yellow-600/70 text-xxs font-medium pointer-events-none';
      label.textContent = 'DEMO DATA';
      wrapper.style.position = 'relative';
      wrapper.appendChild(label);
    }
  }

  const chart = new Chart(ctx, config);
  activeCharts.set(canvasId, chart);
  return chart;
}

export function destroyChart(canvasId) {
  if (activeCharts.has(canvasId)) {
    activeCharts.get(canvasId).destroy();
    activeCharts.delete(canvasId);
  }
}

export function lineChartConfig({ labels, datasets, title, yTickFormat }) {
  return {
    type: 'line',
    data: { labels, datasets: datasets.map(d => ({
      tension: 0.3, fill: true, pointRadius: labels.length > 60 ? 0 : 2, pointHoverRadius: 4,
      borderWidth: 2, backgroundColor: 'rgba(59,130,246,0.08)',
      borderColor: '#3b82f6', ...d,
    })) },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1 },
        title:  { display: !!title, text: title, color: '#94a3b8' },
        tooltip: {
          backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1,
          titleColor: '#f1f5f9', bodyColor: '#94a3b8', padding: 10,
        },
      },
      scales: {
        x: { grid: { color: '#1e293b' }, ticks: { maxTicksLimit: 8 } },
        y: {
          grid: { color: '#1e293b' },
          ticks: {
            callback: yTickFormat || compactTick,
          },
        },
      },
    },
  };
}

export function barChartConfig({ labels, datasets, title, stacked = false }) {
  return {
    type: 'bar',
    data: { labels, datasets: datasets.map((d, i) => ({
      borderRadius: 4, borderSkipped: false,
      backgroundColor: PALETTE[i % PALETTE.length],
      ...d,
    })) },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: datasets.length > 1 },
        title:  { display: !!title, text: title, color: '#94a3b8' },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 },
      },
      scales: {
        x: { stacked, grid: { display: false } },
        y: { stacked, grid: { color: '#1e293b' }, ticks: { callback: compactTick } },
      },
    },
  };
}

export function doughnutChartConfig({ labels, data, colors }) {
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors || PALETTE,
        borderColor: '#0f172a', borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { padding: 16 } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 },
      },
      cutout: '65%',
    },
  };
}
