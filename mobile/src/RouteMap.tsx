import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { colors, fonts, radius } from './theme';
import type { RouteResponse } from './types';

const WIDTH = 320;
const HEIGHT = 150;

export default function RouteMap({ route, height = HEIGHT, showEmpty = true }: { route: RouteResponse | null; height?: number; showEmpty?: boolean }) {
  const drawn = useMemo(() => {
    const points = (route?.points ?? []).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (points.length < 2) return null;
    const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const spanLat = Math.max(1e-6, maxLat - minLat), spanLng = Math.max(1e-6, maxLng - minLng);
    // Keep the true aspect ratio so the trail is not distorted by latitude.
    const ratio = (spanLng * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180)) / spanLat;
    const padding = 14;
    const innerW = WIDTH - padding * 2, innerH = height - padding * 2;
    let scale = Math.min(innerW / (spanLng * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) || 1), innerH / spanLat || 1);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    const usedW = spanLng * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) * scale;
    const usedH = spanLat * scale;
    const offsetX = (WIDTH - usedW) / 2, offsetY = (height - usedH) / 2;
    const project = (lat: number, lng: number) => ({
      x: offsetX + (lng - minLng) * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180) * scale,
      y: offsetY + (maxLat - lat) * scale,
    });
    const path = points.map((p, index) => {
      const { x, y } = project(p.lat, p.lng);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return { path, start: project(points[0].lat, points[0].lng), end: project(points[points.length - 1].lat, points[points.length - 1].lng), count: points.length, ratio };
  }, [route, height]);

  if (!drawn) {
    if (!showEmpty) return null;
    return (
      <View style={[styles.empty, { height }]}>
        <Text style={styles.emptyIcon}>◌</Text>
        <Text style={styles.emptyTitle}>لا يوجد مسار مسجل بعد</Text>
        <Text style={styles.emptyHint}>ابدأ الوردية وسيُرسم خط سيرك هنا تلقائيًا.</Text>
      </View>
    );
  }
  return (
    <View style={styles.wrap}>
      <Svg width="100%" height={height} viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="xMidYMid meet">
        <Defs>
          <LinearGradient id="trail" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colors.green300} />
            <Stop offset="1" stopColor={colors.green700} />
          </LinearGradient>
        </Defs>
        <Path d={drawn.path} stroke={colors.mintDeep} strokeWidth={9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <Path d={drawn.path} stroke="url(#trail)" strokeWidth={4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <Circle cx={drawn.start.x} cy={drawn.start.y} r={6} fill={colors.white} stroke={colors.green700} strokeWidth={2.5} />
        <Circle cx={drawn.end.x} cy={drawn.end.y} r={7} fill={colors.green700} stroke={colors.white} strokeWidth={2.5} />
        <Circle cx={drawn.end.x} cy={drawn.end.y} r={13} fill={colors.green700} opacity={0.14} />
      </Svg>
      <View style={styles.legend}>
        <Text style={styles.legendText}>● بداية</Text>
        <Text style={styles.legendText}>● آخر نقطة</Text>
        <Text style={styles.legendText}>{(drawn.count).toLocaleString('ar-EG')} نقطة</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.cream },
  legend: { flexDirection: 'row-reverse', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 2 },
  legendText: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.muted },
  empty: { borderRadius: radius.md, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', gap: 2 },
  emptyIcon: { fontSize: 24, color: colors.green300 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 13, color: colors.green900 },
  emptyHint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.muted, textAlign: 'center' },
});
