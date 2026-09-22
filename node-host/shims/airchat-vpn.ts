/**
 * Node-замена локального модуля `airchat-vpn`.
 *
 * Встроенный VPN — это Xray в нативном процессе и системный tun-интерфейс;
 * поднимать его из Node нечем. `null`, а не Proxy, — по той же причине, что и
 * у `airchat-openflux`: контракт модуля описывает отсутствие именно как null,
 * и `airChatVpnController` с `ipfsFetch` проверяют `if (!mod)`.
 */
import type { AirChatVpnNative } from '../../modules/airchat-vpn/src';

const AirChatVpn: AirChatVpnNative | null = null;

export default AirChatVpn;
