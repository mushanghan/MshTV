import { create } from 'zustand';
export const useServerState = create<{ stopping: boolean }>(() => ({ stopping: false }));
