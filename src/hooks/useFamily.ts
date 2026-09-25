import { useState, useCallback, useMemo, useEffect } from 'react';
import { FamilyStore, notifyFamilyDataChanged, onFamilyDataChanged } from '../api/family';
import { FamilyMember } from '../types/family';

export function useFamily() {
  const store = useMemo(() => new FamilyStore(), []);
  // Start with localStorage data immediately, then update from server
  const [members, setMembers] = useState<FamilyMember[]>(() => store.getMembersSync());

  const refresh = useCallback(async () => {
    const m = await store.getMembers();
    setMembers(m);
  }, [store]);

  useEffect(() => {
    refresh();
    return onFamilyDataChanged(store, () => void refresh());
  }, [refresh, store]);

  const addMember = useCallback(
    async (member: Omit<FamilyMember, 'id'>) => {
      await store.addMember(member);
      await refresh();
      notifyFamilyDataChanged(store);
    },
    [store, refresh]
  );

  const updateMember = useCallback(
    async (id: string, data: Partial<Omit<FamilyMember, 'id'>>) => {
      await store.updateMember(id, data);
      await refresh();
      notifyFamilyDataChanged(store);
    },
    [store, refresh]
  );

  const removeMember = useCallback(
    async (id: string) => {
      await store.removeMember(id);
      await refresh();
      notifyFamilyDataChanged(store);
    },
    [store, refresh]
  );

  const getMemberById = useCallback(
    (id: string) => members.find((m) => m.id === id) ?? null,
    [members]
  );

  return {
    members,
    addMember,
    updateMember,
    removeMember,
    getMemberById,
    refresh,
  };
}
