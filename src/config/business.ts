export type BusinessProfile = {
  brandName: string;
  coreMarket: string;
  highValueOrderThreshold: number;
  vipCustomerTag: string;
  reviewRequestDelayDays: number;
};

// Central business tuning. Update this file to adapt logic to your store.
const businessProfile: BusinessProfile = {
  brandName: "Bouchra Filali Lahlou",
  coreMarket: "US",
  highValueOrderThreshold: 200,
  vipCustomerTag: "VIP",
  reviewRequestDelayDays: 7
};

export function getBusinessProfile(): BusinessProfile {
  return { ...businessProfile };
}

export function updateBusinessProfile(next: BusinessProfile): BusinessProfile {
  Object.assign(businessProfile, next);
  return getBusinessProfile();
}
