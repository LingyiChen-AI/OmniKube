import { theme, type ThemeConfig } from 'antd';

/**
 * OmniKube design tokens — produced with the ui-ux-pro-max skill.
 *
 * Direction: dark-first "control plane" aesthetic on a slate canvas.
 * - Primary: indigo #0EA5E9 (distinctive vs. default AntD #1677ff).
 * - Status: green (healthy) / amber (warning) / red (error) / sky (info).
 * - Type: Fira Sans for UI, Fira Code for YAML & terminals.
 * Both light & dark variants are designed together (token-driven), so brand,
 * contrast and elevation stay consistent across modes.
 */

export const brand = {
  primary: '#0EA5E9',
  primaryHover: '#38BDF8',
  primaryActive: '#0284C7',
  success: '#22C55E',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#38BDF8',
} as const;

const fontStack =
  "'Fira Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const monoStack = "'Fira Code', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

const sharedToken: ThemeConfig['token'] = {
  colorPrimary: brand.primary,
  colorSuccess: brand.success,
  colorWarning: brand.warning,
  colorError: brand.error,
  colorInfo: brand.info,
  colorLink: brand.primary,
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  fontFamily: fontStack,
  fontFamilyCode: monoStack,
  fontSize: 14,
  controlHeight: 36,
  controlHeightLG: 44,
  controlHeightSM: 28,
  lineHeight: 1.5715,
  wireframe: false,
  motionDurationMid: '0.18s',
};

export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    ...sharedToken,
    colorBgBase: '#0B1020',
    colorBgLayout: '#070B17',
    colorBgContainer: '#111729',
    colorBgElevated: '#161D33',
    colorBorder: '#26304A',
    colorBorderSecondary: '#1B2335',
    colorText: '#E6EAF2',
    colorTextSecondary: '#9AA6BE',
    colorTextTertiary: '#6B7793',
    colorFillQuaternary: 'rgba(255,255,255,0.03)',
    colorPrimaryHover: brand.primaryHover,
    colorPrimaryActive: brand.primaryActive,
    boxShadow: '0 12px 32px rgba(2,6,23,0.55)',
    boxShadowSecondary: '0 8px 24px rgba(2,6,23,0.45)',
  },
  components: {
    Layout: {
      headerBg: 'rgba(13,18,33,0.85)',
      siderBg: '#0A0F1E',
      bodyBg: '#070B17',
      headerHeight: 60,
      headerPadding: '0 20px',
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: 'rgba(14,165,233,0.16)',
      itemSelectedColor: '#BAE6FD',
      itemHoverBg: 'rgba(255,255,255,0.04)',
      itemHeight: 42,
      itemBorderRadius: 8,
      iconSize: 17,
    },
    Card: {
      colorBgContainer: '#111729',
      headerBg: 'transparent',
    },
    Table: {
      headerBg: '#0E1424',
      headerColor: '#AEB8CE',
      headerSplitColor: '#26304A',
      headerBorderRadius: 10,
      rowHoverBg: 'rgba(14,165,233,0.09)',
      borderColor: '#1B2335',
      colorBorderSecondary: '#1B2335',
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
    },
    Button: {
      primaryShadow: '0 6px 16px rgba(14,165,233,0.35)',
      fontWeight: 500,
    },
    Drawer: { colorBgElevated: '#0E1424' },
    Modal: { contentBg: '#111729', headerBg: '#111729' },
    Input: { colorBgContainer: '#0E1424' },
    Select: { colorBgContainer: '#0E1424' },
    Tooltip: { colorBgSpotlight: '#1F2942' },
  },
};

export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    ...sharedToken,
    // Clean white scheme: very-light-gray canvas, pure-white surfaces.
    colorBgBase: '#FFFFFF',
    colorBgLayout: '#F5F7FA',
    colorBgContainer: '#FFFFFF',
    colorBgElevated: '#FFFFFF',
    colorBorder: '#E3E8F0',
    colorBorderSecondary: '#EDF1F7',
    colorText: '#0F172A',
    colorTextSecondary: '#475569',
    colorTextTertiary: '#94A3B8',
    colorTextQuaternary: '#B6C0CF',
    colorFillQuaternary: 'rgba(15,23,42,0.02)',
    colorFillTertiary: 'rgba(15,23,42,0.04)',
    colorPrimaryHover: brand.primaryHover,
    colorPrimaryActive: brand.primaryActive,
    // Soft, readable elevation for a polished light UI.
    boxShadow: '0 8px 24px rgba(15,23,42,0.06)',
    boxShadowSecondary: '0 4px 16px rgba(15,23,42,0.05)',
    boxShadowTertiary: '0 1px 2px rgba(15,23,42,0.04)',
  },
  components: {
    Layout: {
      headerBg: 'rgba(255,255,255,0.92)',
      siderBg: '#0B1020',
      bodyBg: '#F5F7FA',
      headerHeight: 60,
      headerPadding: '0 20px',
    },
    Menu: {
      // Sidebar stays dark in light mode for a consistent "console rail" look.
      darkItemBg: 'transparent',
      darkItemSelectedBg: 'rgba(14,165,233,0.22)',
      darkItemSelectedColor: '#BAE6FD',
      darkItemHoverBg: 'rgba(255,255,255,0.06)',
      itemHeight: 42,
      itemBorderRadius: 8,
      iconSize: 17,
    },
    Card: {
      colorBgContainer: '#FFFFFF',
      headerBg: 'transparent',
      boxShadowTertiary: '0 1px 2px rgba(15,23,42,0.05)',
    },
    Table: {
      headerBg: '#F8FAFC',
      headerColor: '#475569',
      headerSplitColor: '#E3E8F0',
      headerBorderRadius: 10,
      rowHoverBg: 'rgba(14,165,233,0.05)',
      borderColor: '#EDF1F7',
      colorBorderSecondary: '#EDF1F7',
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
    },
    Button: {
      primaryShadow: '0 6px 16px rgba(14,165,233,0.22)',
      fontWeight: 500,
    },
    Drawer: { colorBgElevated: '#FFFFFF' },
    Modal: { contentBg: '#FFFFFF', headerBg: '#FFFFFF' },
    Input: { colorBgContainer: '#FFFFFF' },
    Select: { colorBgContainer: '#FFFFFF' },
    Tooltip: { colorBgSpotlight: '#1E293B' },
  },
};

export function getTheme(mode: 'dark' | 'light'): ThemeConfig {
  return mode === 'dark' ? darkTheme : lightTheme;
}
