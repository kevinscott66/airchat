# Long Range Transport Modules

## Educational research modules

These modules are for **educational research only**. They are not shipped product capabilities and must not appear in the UI without separate implementation, testing and review.

| Module | Technology | Status |
| --- | --- | --- |
| `hfRadio.ts` | HF radio (Xiegu G90, Yaesu FT-817) over USB serial | Backlog-only |
| `lora.ts` | LoRa / Meshtastic | Backlog-only |
| `wifiMesh.ts` | Wi-Fi Direct Mesh | Backlog-only |
| `geographicRouter.ts` | Geographic routing | Internal prototype, not UI |
| `opportunisticSync.ts` | Opportunistic encounter synchronization | Backlog-only |
| `relayService.ts` | Relay through other devices | Backlog-only |

## Requirements for real operation

Native modules would be required:

- HF radio: `react-native-usb-serial`, potentially with an Expo config plugin.
- LoRa: `react-native-serialport` or a USB adapter.
- Wi-Fi Direct: `react-native-wifi-direct`, Android only.

Check compatibility with the project's Expo SDK and React Native before installing. Some libraries require a fork for the new architecture.

## Radio licensing

Radio use must comply with local regulations. The original design notes require an amateur-radio license for HF operation in Russia and describe low-power 868 MHz LoRa operation within applicable unlicensed-device limits. Verify current requirements for the actual equipment and jurisdiction before use.

## Integration

Startup from `src/App.tsx` is guarded by `LONG_RANGE_PIPELINE_ENABLED` in `pipelineFlag.ts`, currently `false`. While disabled, `initLongRangeTransport()` is a no-op and does not touch native Wi-Fi Direct. Remaining prerequisites are listed in `pipelineFlag.ts`. Prototype readiness logs do not establish user availability or production readiness.
