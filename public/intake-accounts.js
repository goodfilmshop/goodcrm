(function (root, factory) {
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.IntakeAccounts = catalog;
})(typeof window === 'object' ? window : globalThis, function () {
  const channels = Object.freeze(['line', 'facebook', 'instagram']);
  const accounts = {
    line: [
      { key: 'gfs-line-249izgyn', label: '3M Dealer Support · @3mfilm', company: 'GFS' },
      { key: 'gfs-line-095jvuls', label: 'บจก.กู๊ดฟิล์ม · @goodfilm', company: 'GFS' },
      { key: 'mhl-line-320opqkc', label: 'ร้านมโหฬารฟิล์ม · @mhl1', company: 'MHL' },
      { key: 'car-line-fkq6145q', label: 'รถยนต์ · @maholan', company: 'CAR' },
    ],
    // Existing Facebook keys contain historical company prefixes. Keep the IDs
    // intact; display the same current GFS/MHL/CAR labels as the intake tabs.
    facebook: [
      { key: 'gfs-fb-125106670932394', label: 'FB-GFS', company: 'GFS' },
      { key: 'gfs-fb-101634951180913', label: 'FB-MHL', company: 'MHL' },
      { key: 'mhl-fb-109607531869658', label: 'FB-CAR', company: 'CAR' },
    ],
    instagram: [
      { key: 'gfs-ig-17841402497215021', label: 'IG-GFS · @goodfilm.shop', company: 'GFS' },
      { key: 'mhl-ig-17841421260722221', label: 'IG-MHL · @maholan.film', company: 'MHL' },
      { key: 'car-ig-17841458662245781', label: 'IG-CAR · @mhlcarfilm', company: 'CAR' },
    ],
  };
  for (const channel of channels) {
    accounts[channel] = Object.freeze(accounts[channel].map(Object.freeze));
  }
  return Object.freeze({ channels, accounts: Object.freeze(accounts) });
});
