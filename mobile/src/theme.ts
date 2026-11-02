import { Platform } from 'react-native';

export const colors = {
  // Elhelb Group identity: deep navy + gold + sky, matching the official logo.
  ink: '#101e2d',
  green900: '#071726',
  green800: '#0a1f33',
  green700: '#123f5e',
  green500: '#2fa8dc',
  green300: '#8fc3de',
  mint: '#eaf4fb',
  mintDeep: '#d6e8f5',
  cream: '#f3f6fa',
  sand: '#e6ecf3',
  gold: '#c9a227',
  amber: '#b18d1f',
  amberSoft: '#fbf3da',
  danger: '#b4232a',
  dangerSoft: '#fdecec',
  white: '#ffffff',
  muted: '#5b7186',
  line: '#e1e8f0',
  overlay: 'rgba(7,23,38,0.5)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 22, xxl: 30 };
export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 };

export const fonts = {
  regular: 'NotoNaskhArabic_400Regular',
  bold: 'NotoNaskhArabic_700Bold',
  medium: 'NotoNaskhArabic_500Medium',
};

export const shadow = Platform.select({
  ios: { shadowColor: '#123026', shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
  android: { elevation: 3 },
  default: {},
});
