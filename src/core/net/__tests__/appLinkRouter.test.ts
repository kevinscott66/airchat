import { buildPostLink } from '../appLink';
import { routeAppLink, setAppLinkHandler } from '../appLinkRouter';

describe('своя ссылка внутри приложения не уходит в браузер', () => {
  afterEach(() => setAppLinkHandler(null));

  it('наша ссылка отдаётся обработчику', () => {
    const seen: string[] = [];
    setAppLinkHandler((u) => seen.push(u));
    const web = buildPostLink('f_1_ab').web;
    expect(routeAppLink(web)).toBe(true);
    expect(seen).toEqual([web]);
  });

  it('чужой адрес обработчику не достаётся', () => {
    const seen: string[] = [];
    setAppLinkHandler((u) => seen.push(u));
    expect(routeAppLink('https://example.com/l/../post')).toBe(false);
    expect(routeAppLink('https://example.com/blog/post')).toBe(false);
    expect(routeAppLink(42)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('без обработчика ссылка уходит наружу, а не пропадает', () => {
    // Именно false: true означало бы «уже открыли», и нажатие не сделало бы
    // ничего — то самое молчание, ради которого написан openExternal.
    setAppLinkHandler(null);
    expect(routeAppLink(buildPostLink('f_1_ab').web)).toBe(false);
  });

  it('снятый обработчик больше не зовётся', () => {
    const seen: string[] = [];
    setAppLinkHandler((u) => seen.push(u));
    setAppLinkHandler(null);
    expect(routeAppLink(buildPostLink('f_1_ab').web)).toBe(false);
    expect(seen).toEqual([]);
  });
});
