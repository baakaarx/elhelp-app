import { Platform } from 'react-native';

export const colors = {
  ink: '#14231c',
  green900: '#123026',
  green800: '#16382c',
  green700: '#1f513f',
  green500: '#2f7a5f',
  green300: '#79a98f',
  mint: '#e8f1ea',
  mintDeep: '#d6e6da',
  cream: '#f7f4ec',
  sand: '#efe9db',
  gold: '#c9a227',
  amber: '#b45309',
  amberSoft: '#fdf1dc',
  danger: '#a52a2a',
  dangerSoft: '#fbeaea',
  white: '#fffdf8',
  muted: '#6b7a70',
  line: '#e2e8e1',
  overlay: 'rgba(18,48,38,0.45)',
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
