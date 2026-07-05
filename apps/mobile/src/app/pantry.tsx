import { formatEuroCents } from '@prakkie/shared';
import { useRouter } from 'expo-router';
import { Plus, Trash2, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteRow, syncNow, upsertRow, useEntityRows } from '../data';
import { authedRequest } from '../data/api';
import { colors, radius, type } from '../theme/tokens';

interface PantryRow { id: string; name: string; quantity: number | string | null; unit: string | null }
interface Suggestion { id: string; title: string; missing_count: number; total: number; missing: string[] }

/** Voorraadkast (WS8 I1/I2): manual add, cook-from-pantry over eigen bibliotheek. */
export default function PantryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { rows } = useEntityRows('pantry_items');
  const [name, setName] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const items = rows.map((r) => r.row as unknown as PantryRow);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        await syncNow(['pantry_items']);
        const res = await authedRequest('/v1/pantry/cook-suggestions');
        if (res.ok) setSuggestions(((await res.json()) as { suggestions: Suggestion[] }).suggestions.slice(0, 6));
      } catch {
        /* offline is fine */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [rows.length]);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await upsertRow('pantry_items', { name: trimmed, source: 'manual' });
    setName('');
    syncNow(['pantry_items']).catch(() => {});
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <View style={styles.headerRow}>
        <Text style={type.screenTitle}>Voorraadkast</Text>
        <Pressable onPress={() => router.back()} style={styles.close}>
          <X size={20} color={colors.textSoft} />
        </Pressable>
      </View>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="bijv. rijst, olijfolie, uien…"
          placeholderTextColor={colors.textMuted2}
          value={name}
          onChangeText={setName}
          onSubmitEditing={add}
        />
        <Pressable style={styles.addBtn} onPress={add}>
          <Plus size={20} color={colors.onPrimary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 40, gap: 8 }} showsVerticalScrollIndicator={false}>
        {suggestions.length ? (
          <>
            <Text style={[type.h2, { marginTop: 6 }]}>Koken met je voorraad</Text>
            {suggestions.map((s) => (
              <Pressable key={s.id} style={styles.suggestion} onPress={() => router.push(`/recipe/${s.id}`)}>
                <View style={{ flex: 1 }}>
                  <Text style={type.body} numberOfLines={1}>{s.title}</Text>
                  <Text style={type.meta}>
                    {s.missing_count === 0
                      ? 'alles in huis!'
                      : `nog ${s.missing_count} nodig: ${s.missing.slice(0, 3).join(', ')}${s.missing.length > 3 ? '…' : ''}`}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        <Text style={[type.h2, { marginTop: 10 }]}>In huis · {items.length}</Text>
        {items.length === 0 ? (
          <Text style={type.meta}>Nog leeg. Voeg toe wat je in huis hebt — recepten en lijstjes houden er rekening mee.</Text>
        ) : (
          items.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <Text style={[type.body, { flex: 1 }]}>{item.name}</Text>
              <Pressable
                hitSlop={10}
                onPress={async () => {
                  await deleteRow('pantry_items', item.id);
                  syncNow(['pantry_items']).catch(() => {});
                }}
              >
                <Trash2 size={17} color={colors.textMuted} />
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

void formatEuroCents; // reserved for price badges on suggestions

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, gap: 14 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  close: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.borderSubtle,
  },
  inputRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.control, paddingHorizontal: 14,
    paddingVertical: 12, borderWidth: 1, borderColor: colors.borderSubtle, ...type.body,
  },
  addBtn: {
    width: 46, borderRadius: radius.control, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  suggestion: {
    backgroundColor: colors.badgeBg, borderRadius: radius.control, padding: 12,
    borderWidth: 1, borderColor: colors.borderSubtle,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.surface,
    borderRadius: radius.control, padding: 12, borderWidth: 1, borderColor: colors.borderSubtle,
  },
});
