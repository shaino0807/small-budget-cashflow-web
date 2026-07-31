function productCatalog() {
  return {
    full_report: {
      productType: "full_report",
      name: "完整報告",
      amount: Math.max(1, Math.round(Number(process.env.FULL_REPORT_PRICE_TWD || 499))),
      entitlement: "full_report",
      description: "小資現金流完整報告"
    },
    consultation_deposit: {
      productType: "consultation_deposit",
      name: "諮詢訂金",
      amount: Math.max(1, Math.round(Number(process.env.CONSULTATION_DEPOSIT_TWD || 200))),
      entitlement: "consultation_deposit",
      description: "一對一諮詢預約訂金"
    }
  };
}

function productFor(type) {
  const product = productCatalog()[type];
  if (!product) {
    const error = new Error("不支援的付款項目");
    error.statusCode = 400;
    throw error;
  }
  return product;
}

function entitlementForProduct(type) {
  return productCatalog()[type]?.entitlement || null;
}

module.exports = { entitlementForProduct, productCatalog, productFor };
