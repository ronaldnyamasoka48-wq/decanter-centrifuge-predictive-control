import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Decanter Centrifuge Digital Twin | Predictive Control System',
  description:
    'AI-powered digital twin for decanter centrifuge operations. Predictive and adaptive control for bowl speed, scroll conveyor speed, flow rate, and energy consumption.',
  keywords: ['digital twin', 'centrifuge', 'predictive control', 'DC motor', 'industrial automation'],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head>
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%2300d4ff' opacity='0.8'/><circle cx='50' cy='50' r='25' fill='%237c3aed' opacity='0.9'/></svg>" />
      </head>
      <body className="min-h-screen bg-[#020714] antialiased">{children}</body>
    </html>
  );
}
