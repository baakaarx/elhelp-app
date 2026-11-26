/** A short, local chime: no network request or browser notification permission is required. */
export async function orderChime(context: AudioContext): Promise<void> {
  if (context.state !== 'running') await context.resume();
  if (context.state !== 'running') throw new Error('تعذر تشغيل الصوت في المتصفح.');
  const now = context.currentTime;
  const gain = context.createGain();
  gain.connect(context.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.13, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(660, now);
  tone.frequency.setValueAtTime(880, now + 0.20);
  tone.connect(gain);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(now);
  tone.stop(now + 0.5);
}
