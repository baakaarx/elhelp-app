import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, fonts, radius, shadow, space } from './theme';

export function Card({ children, style, tone = 'plain' }: { children: ReactNode; style?: any; tone?: 'plain' | 'mint' | 'dark' }) {
  return <View style={[styles.card, tone === 'mint' && styles.cardMint, tone === 'dark' && styles.cardDark, style]}>{children}</View>;
}

export function Row({ children, style }: { children: ReactNode; style?: any }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Title({ children, style }: { children: ReactNode; style?: any }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}
export function Heading({ children, style }: { children: ReactNode; style?: any }) {
  return <Text style={[styles.heading, style]}>{children}</Text>;
}
export function Body({ children, style, muted }: { children: ReactNode; style?: any; muted?: boolean }) {
  return <Text style={[muted ? styles.muted : styles.body, style]}>{children}</Text>;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'soft';
  size?: 'md' | 'sm';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
  style?: any;
};
export function Button({ label, onPress, variant = 'primary', size = 'md', icon, disabled, loading, style }: ButtonProps) {
  const palette = {
    primary: { bg: colors.green700, fg: '#fdf8ec', border: colors.green700 },
    ghost: { bg: 'transparent', fg: colors.green900, border: colors.line },
    soft: { bg: colors.mint, fg: colors.green900, border: colors.mint },
    danger: { bg: colors.danger, fg: '#fff', border: colors.danger },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        size === 'sm' && styles.buttonSm,
        { backgroundColor: palette.bg, borderColor: palette.border },
        (disabled || loading) && { opacity: 0.55 },
        pressed && { transform: [{ scale: 0.99 }] },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : (
        <Text style={[styles.buttonText, size === 'sm' && styles.buttonTextSm, { color: palette.fg }]}>
          {icon ? `${icon}  ` : ''}{label}
        </Text>
      )}
    </Pressable>
  );
}

export function Pill({ label, tone = 'mint' }: { label: string; tone?: 'mint' | 'warn' | 'danger' | 'dark' }) {
  const bg = { mint: colors.mint, warn: colors.amberSoft, danger: colors.dangerSoft, dark: 'rgba(255,255,255,0.14)' }[tone];
  const fg = { mint: colors.green700, warn: colors.amber, danger: colors.danger, dark: '#f4efe2' }[tone];
  return <View style={[styles.pill, { backgroundColor: bg }]}><Text style={[styles.pillText, { color: fg }]}>{label}</Text></View>;
}

export function Stat({ label, value, unit, tone = 'light' }: { label: string; value: string; unit?: string; tone?: 'light' | 'dark' }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone === 'dark' && { color: '#fdf8ec' }]}>{value}{unit ? <Text style={styles.statUnit}> {unit}</Text> : null}</Text>
      <Text style={[styles.statLabel, tone === 'dark' && { color: 'rgba(253,248,236,0.72)' }]}>{label}</Text>
    </View>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor="#9aa79f" {...props} style={[styles.input, props.style]} />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return <View style={styles.sectionTitle}><Text style={styles.heading}>{title}</Text>{action}</View>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={styles.heading}>{title}</Text>
              <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="إغلاق"><Text style={styles.close}>✕</Text></Pressable>
            </Row>
            <ScrollView contentContainerStyle={{ gap: space.md, paddingBottom: space.xl }} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
    padding: space.lg, gap: space.sm, ...(shadow as object),
  },
  cardMint: { backgroundColor: colors.mint, borderColor: colors.mintDeep },
  cardDark: { backgroundColor: colors.green800, borderColor: colors.green800 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: space.sm },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.green900, textAlign: 'right', lineHeight: 38 },
  heading: { fontFamily: fonts.bold, fontSize: 17, color: colors.green900, textAlign: 'right' },
  body: { fontFamily: fonts.regular, fontSize: 15, color: colors.ink, textAlign: 'right', lineHeight: 25 },
  muted: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.muted, textAlign: 'right', lineHeight: 21 },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'right', lineHeight: 18 },
  button: { borderRadius: radius.md, borderWidth: 1, paddingVertical: 14, alignItems: 'center', justifyContent: 'center' },
  buttonSm: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: radius.sm },
  buttonText: { fontFamily: fonts.bold, fontSize: 15 },
  buttonTextSm: { fontSize: 13 },
  pill: { borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 2, alignSelf: 'flex-start' },
  pillText: { fontFamily: fonts.medium, fontSize: 11 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontFamily: fonts.bold, fontSize: 21, color: colors.green900, writingDirection: 'rtl' },
  statUnit: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted },
  statLabel: { fontFamily: fonts.regular, fontSize: 11, color: colors.muted, textAlign: 'center' },
  label: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.muted, textAlign: 'right' },
  input: {
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontFamily: fonts.regular, fontSize: 15, color: colors.ink, textAlign: 'right',
  },
  sectionTitle: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  empty: { alignItems: 'center', gap: 4, paddingVertical: space.lg },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 14, color: colors.green900, textAlign: 'center' },
  sheetBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheetWrap: { maxHeight: '94%' },
  sheet: {
    backgroundColor: colors.cream, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    padding: space.lg, paddingBottom: space.md, gap: space.md, maxHeight: '94%',
  },
  sheetHandle: { width: 44, height: 4, borderRadius: 2, backgroundColor: colors.mintDeep, alignSelf: 'center', marginBottom: 4 },
  close: { fontFamily: fonts.bold, fontSize: 18, color: colors.muted, paddingHorizontal: 6 },
});
