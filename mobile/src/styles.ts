import { StyleSheet, Platform } from 'react-native';

export const colors = {
  green900: '#16382c', green700: '#1f513f', green500: '#2f7a5f', green100: '#e8f1ea',
  sand: '#f7f4ec', ink: '#1d2521', muted: '#6b7a70', line: '#dfe6df', card: '#fffdf8',
  amber: '#b45309', amber100: '#fdf1dc', danger: '#a52a2a', white: '#ffffff',
};
const arabic = Platform.select({ ios: 'NotoNaskhArabic', android: 'NotoNaskhArabic', default: 'system-ui' });

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.sand },
  safe: { flex: 1, paddingTop: Platform.OS === 'ios' ? 0 : 8 },
  scroll: { padding: 16, paddingBottom: 40, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  title: { fontSize: 24, fontWeight: '700', color: colors.green900, textAlign: 'right', fontFamily: arabic },
  h2: { fontSize: 18, fontWeight: '700', color: colors.green900, textAlign: 'right', fontFamily: arabic },
  label: { fontSize: 13, color: colors.muted, textAlign: 'right', marginBottom: 4, fontFamily: arabic },
  text: { fontSize: 15, color: colors.ink, textAlign: 'right', fontFamily: arabic, lineHeight: 24 },
  muted: { fontSize: 12, color: colors.muted, textAlign: 'right', fontFamily: arabic, lineHeight: 20 },
  input: {
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 9, fontSize: 15,
    color: colors.ink, textAlign: 'right', fontFamily: arabic,
  },
  inputLtr: { textAlign: 'left', writingDirection: 'ltr' },
  card: {
    backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 16, gap: 10,
    shadowColor: '#16382c', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 2,
  },
  button: { backgroundColor: colors.green700, borderRadius: 14, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fdf8ec', fontSize: 16, fontWeight: '700', fontFamily: arabic },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  buttonGhostText: { color: colors.green900, fontSize: 15, fontWeight: '600', fontFamily: arabic },
  buttonDanger: { backgroundColor: colors.danger, borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  chipActive: { backgroundColor: colors.green700, borderColor: colors.green700 },
  chipText: { fontSize: 13, color: colors.green900, fontFamily: arabic },
  chipTextActive: { color: '#fdf8ec' },
  banner: { backgroundColor: colors.amber100, borderBottomWidth: 1, borderBottomColor: '#f0dcb8', paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { color: '#6b4413', fontSize: 13, textAlign: 'right', fontFamily: arabic },
  live: { backgroundColor: colors.green100, borderBottomWidth: 1, borderBottomColor: '#cfe3d5', paddingHorizontal: 16, paddingVertical: 10 },
  liveText: { color: colors.green900, fontSize: 13, textAlign: 'right', fontFamily: arabic, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 13, textAlign: 'right', fontFamily: arabic },
  ok: { color: colors.green700, fontSize: 13, textAlign: 'right', fontFamily: arabic },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green500 },
  dotLive: { backgroundColor: '#d13438' },
  tabBar: { flexDirection: 'row-reverse', backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.line, paddingBottom: Platform.OS === 'ios' ? 18 : 8, paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 4 },
  tabText: { fontSize: 12, color: colors.muted, fontFamily: arabic },
  tabTextActive: { color: colors.green900, fontWeight: '700' },
  stat: { flex: 1, backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 12, alignItems: 'center', gap: 2 },
  statValue: { fontSize: 20, fontWeight: '700', color: colors.green900, fontFamily: arabic },
  statLabel: { fontSize: 11, color: colors.muted, textAlign: 'center', fontFamily: arabic },
  tableRow: { flexDirection: 'row-reverse', borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 8, gap: 8 },
  cell: { flex: 1, fontSize: 12, color: colors.ink, textAlign: 'right', fontFamily: arabic },
});
export default styles;
