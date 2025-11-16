declare const unrlPresenceAPI: {
    update: (payload: unknown) => void;
    clear: () => void;
    ping: () => Promise<{
        origin: string;
        hasDiscord: boolean;
    }>;
};
declare global {
    interface Window {
        unrlPresence: typeof unrlPresenceAPI;
    }
}
export {};
//# sourceMappingURL=preload.d.ts.map