import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppPressable } from '../../components/AppPressable';
import { openMapAt } from '../../utils/openExternal';
import { MAP_PAPER, mediaScrim } from '../../theme';
import { parseLocationMeta } from '../ChatScreen';
import { useBubbleSurface } from '../../BubbleKindContext';

const TILE = 256;
const ZOOM = 15;
const PREVIEW_W = 220;
const PREVIEW_H = 132;

interface TilePos { key: string; uri: string; left: number; top: number; isCenter: boolean }

// Slippy-map tiles for a small, keyless map preview. Renders the 3x3 block of
// OSM tiles centred on the point (guaranteeing full coverage of the preview box)
// and overlays a pin at the exact pixel offset of the coordinate.
function buildTiles(lat: number, lon: number): TilePos[] {
  const n = 2 ** ZOOM;
  const latRad = (lat * Math.PI) / 180;
  const xGlobal = ((lon + 180) / 360) * n;
  const yGlobal = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const xtile = Math.floor(xGlobal);
  const ytile = Math.floor(yGlobal);
  const px = (xGlobal - xtile) * TILE; // pixel of the point inside its tile
  const py = (yGlobal - ytile) * TILE;
  const baseLeft = PREVIEW_W / 2 - px;
  const baseTop = PREVIEW_H / 2 - py;
  const tiles: TilePos[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xt = (((xtile + dx) % n) + n) % n; // wrap longitude
      const yt = ytile + dy;
      if (yt < 0 || yt >= n) continue; // skip beyond the poles
      // v4.32.226: OpenStreetMap's tile CDN returns HTTP 403 ("Blocked") for
      // this app's egress (region/IP-level block, NOT a User-Agent issue —
      // confirmed: OSM serves 200 to any UA from other networks but 403 to the
      // device). Carto's free Voyager basemap is reachable from the same
      // network and renders a colourful street map. @2x for retina crispness.
      const sub = ['a', 'b', 'c', 'd'][(((xt + yt) % 4) + 4) % 4];
      tiles.push({
        key: `${dx}_${dy}`,
        uri: `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${ZOOM}/${xt}/${yt}@2x.png`,
        left: baseLeft + dx * TILE,
        top: baseTop + dy * TILE,
        isCenter: dx === 0 && dy === 0,
      });
    }
  }
  return tiles;
}

export function LocationBubble({ text, isOutgoing }: { text: string; isOutgoing: boolean }): React.ReactElement | null {
  // v4.32.411: подписи и превью — от заливки пузыря. Превью карты во ВХОДЯЩЕМ
  // пузыре заливалось `surfaceHigh` поверх пузыря того же `surfaceHigh`,
  // то есть блока не было видно вовсе.
  const bubble = useBubbleSurface(isOutgoing);
  const [mapFailed, setMapFailed] = useState(false);
  const meta = parseLocationMeta(text);
  if (!meta) return null;
  const textColor = bubble.ink.text;
  const mutedColor = bubble.ink.secondary;
  const iconColor = bubble.icon;
  const coords = `${meta.lat.toFixed(5)}, ${meta.lon.toFixed(5)}`;
  const title = meta.label || 'Геолокация';
  const tiles = mapFailed ? [] : buildTiles(meta.lat, meta.lon);

  return (
    <AppPressable
      style={{ width: PREVIEW_W, borderRadius: 14, overflow: 'hidden', backgroundColor: bubble.plate.fill }}
      onPress={() => openMapAt(meta.lat, meta.lon)}
    >
      {!mapFailed ? (
        <View style={{ width: PREVIEW_W, height: PREVIEW_H, backgroundColor: MAP_PAPER }}>
          {tiles.map((t) => (
            <Image
              key={t.key}
              source={{ uri: t.uri }}
              style={{ position: 'absolute', width: TILE, height: TILE, left: t.left, top: t.top }}
              onError={t.isCenter ? () => setMapFailed(true) : undefined}
            />
          ))}
          {/* Pin: tip points to the exact coordinate at the box centre. */}
          <View style={{ position: 'absolute', left: PREVIEW_W / 2 - 15, top: PREVIEW_H / 2 - 28, alignItems: 'center' }}>
            {/* Тайлы карты — чужой кадр: цвет под булавкой неизвестен, но
                ограничен, поэтому красный берётся из mediaScrim (v4.32.403). */}
            <Ionicons name="location" size={32} color={mediaScrim.error} />
          </View>
          {/* «open in maps» affordance. */}
          <View style={{ position: 'absolute', top: 6, right: 6, backgroundColor: mediaScrim.bar, borderRadius: 11, padding: 4 }}>
            <Ionicons name="open-outline" size={14} color={mediaScrim.ink} />
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: mapFailed ? 0 : 8, paddingHorizontal: mapFailed ? 0 : 8, minWidth: mapFailed ? 160 : undefined }}>
        <Ionicons name="location" size={mapFailed ? 28 : 18} color={iconColor} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ color: textColor, fontWeight: '600', fontSize: 13 }}>{title}</Text>
          <Text numberOfLines={1} style={{ color: mutedColor, fontSize: 11 }}>{coords}</Text>
        </View>
        {mapFailed ? <Ionicons name="open-outline" size={16} color={mutedColor} /> : null}
      </View>
    </AppPressable>
  );
}
