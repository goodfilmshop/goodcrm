with source (stock, sku, series, model, size) as (
  values
  (1::numeric, '7100178985', 'Prestige Exterior', 'PR20EX', '60'),
  (0::numeric, '7100178969', 'Prestige Exterior', 'PR20EX', '72'),
  (4::numeric, '7100369108', 'Prestige Exterior', 'PR40EX(48)', '48'),
  (1::numeric, '7100002552', 'Prestige Exterior', 'PR40EX(60)', '60'),
  (4::numeric, '7100002589', 'Prestige Exterior', 'PR40EX(72)', '72'),
  (4::numeric, '7100369205', 'Prestige Exterior', 'PR50EX', '48'),
  (3::numeric, '7100369233', 'Prestige Exterior', 'PR50EX', '60'),
  (5::numeric, '7100368162', 'Prestige Exterior', 'PR50EX', '72'),
  (4::numeric, '7000001470', 'Prestige Exterior', 'PR70EX', '60'),
  (0::numeric, '7000001475', 'Prestige Exterior', 'PR70EX', '72'),
  (0::numeric, '7010375631', 'Prestige', 'PR20(48)', '48'),
  (0::numeric, '7100114743', 'Prestige', 'PR20(60)', '60'),
  (0::numeric, '7010312683', 'Prestige', 'PR20(72)', '72'),
  (0::numeric, '7000001295', 'Prestige', 'PR40(48)', '48'),
  (0::numeric, '7000001288', 'Prestige', 'PR40(60)', '60'),
  (0::numeric, '7100002589', 'Prestige', 'PR40(72)', '72'),
  (0::numeric, '7000001296', 'Prestige', 'PR50(48)', '48'),
  (0::numeric, '7000001290', 'Prestige', 'PR50(60)', '60'),
  (2::numeric, '7000001291', 'Prestige', 'PR50(72)', '72'),
  (2::numeric, '7000001298', 'Prestige', 'PR70(48)', '48'),
  (0::numeric, '7000001293', 'Prestige', 'PR70(60)', '60'),
  (0::numeric, '7000001287', 'Prestige', 'PR70(72)', '72'),
  (0::numeric, '7000049290', 'Night Vision', 'NV15(36)', '36'),
  (6::numeric, '7000001350', 'Night Vision', 'NV15(48)', '48'),
  (9::numeric, '7000001351', 'Night Vision', 'NV15(60)', '60'),
  (8::numeric, '7000001352', 'Night Vision', 'NV15(72)', '72'),
  (3::numeric, '7000049291', 'Night Vision', 'NV25(36)', '36'),
  (2::numeric, '7000049292', 'Night Vision', 'NV25(48)', '48'),
  (2::numeric, '7000029055', 'Night Vision', 'NV25(60)', '60'),
  (3::numeric, '7000049293', 'Night Vision', 'NV25(72)', '72'),
  (0::numeric, '7000049294', 'Night Vision', 'NV35(36)', '36'),
  (9::numeric, '7000049295', 'Night Vision', 'NV35(48)', '48'),
  (8::numeric, '7000001356', 'Night Vision', 'NV35(60)', '60'),
  (7::numeric, '7000001357', 'Night Vision', 'NV35(72)', '72'),
  (9::numeric, '7100317408', 'Ceramic Arch Interior', 'CA35(60)', '60'),
  (17::numeric, '7100317410', 'Ceramic Arch Interior', 'CA35(72)', '72'),
  (30::numeric, '7100317230', 'Ceramic Arch Interior', 'CA45(60)', '60'),
  (24::numeric, '7100317409', 'Ceramic Arch Interior', 'CA45(72)', '72'),
  (31::numeric, '7100317407', 'Ceramic Arch Interior', 'CA60(60)', '60'),
  (36::numeric, '7100317227', 'Ceramic Arch Interior', 'CA60(72)', '60'),
  (6::numeric, '7100317228', 'Ceramic Arch Interior', 'CA80(60)', '60'),
  (21::numeric, '7100317229', 'Ceramic Arch Interior', 'CA80(72)', '72'),
  (17::numeric, '7100206744', 'Ceramic IR', 'CMIR5', '60'),
  (21::numeric, '7100206743', 'Ceramic IR', 'CMIR15', '60'),
  (10::numeric, '7100206742', 'Ceramic IR', 'CMIR25', '60'),
  (11::numeric, '7100206740', 'Ceramic IR', 'CMIR35', '60'),
  (15::numeric, '7100206741', 'Ceramic IR', 'CMIR50', '60'),
  (4::numeric, '7100206739', 'Ceramic IR', 'CMIR70', '60'),
  (0::numeric, '7100136772', 'FX-HP', 'FX-HP 5', '60'),
  (0::numeric, '7000024144', 'FX-HP', 'FX-HP 15', '60'),
  (0::numeric, '7010374216', 'FX-HP', 'FX-HP 20', '60'),
  (0::numeric, '7010374216', 'FX-HP', 'FX-HP 30', '60'),
  (1::numeric, '7100136394', 'FX-HP', 'FX-HP 50', '60'),
  (133::numeric, '7100136597', 'Black Chrome', 'BC10', '60'),
  (9::numeric, '7100136752', 'Black Chrome', 'BC20', '60'),
  (0::numeric, '7100136753', 'Black Chrome', 'BC35', '60'),
  (0::numeric, '7100136769', 'Black Chrome', 'BC40', '60'),
  (4::numeric, '7000049479', 'Reflective', 'P18ARL(36)', '36'),
  (0::numeric, '7100136611', 'Reflective', 'P18ARL(48)', '48'),
  (4::numeric, '7100136881', 'Reflective', 'P18ARL(60)', '60'),
  (6::numeric, '7100135841', 'Reflective', 'P18ARL(72)', '72'),
  (0.00::numeric, '70006795234', 'Obsidian', 'OB5', '60'),
  (0.00::numeric, '70006795242', 'Obsidian', 'OB15', '60'),
  (0.00::numeric, '70006795259', 'Obsidian', 'OB25', '60'),
  (0.00::numeric, '70006795275', 'Obsidian', 'OB35', '60'),
  (9::numeric, '7000034672', 'Safety & Security', 'S40', '60'),
  (0::numeric, '7000034673', 'Safety & Security', 'S70', '60'),
  (1::numeric, '7100042605', 'Safety & Security', 'ULTRAS800', '60'),
  (0::numeric, '7100007704', 'Safety & Security', 'SAS5', '60'),
  (0::numeric, '7100007704', 'Safety & Security', 'SAS20', '60'),
  (1::numeric, '7100007702', 'Safety & Security', 'SAS35', '60'),
  (0::numeric, '7000049515', 'Safety & Security', 'SAS50', '60'),
  (0::numeric, '7012788376', 'Decorations', 'OP-10', '48'),
  (15::numeric, '7000006765', 'Decorations', '5525-314(SANDBLA', '48'),
  (23::numeric, '7000006764', 'Decorations', '5525-324(HAZE)', '48'),
  (7::numeric, '7000005146', 'Decorations', '7725-314', '48'),
  (0::numeric, '7000005146', 'Decorations', '7725-324(Frosted C', '48')
),
prepared as (
  select
    sku,
    '3M'::text as brand,
    case
      when series = 'Safety & Security' then 'ฟิล์มนิรภัย'
      when series = 'Decorations' then 'ฟิล์มตกแต่ง'
      else 'ฟิล์มกรองแสง'
    end as product_type,
    series,
    model,
    size,
    stock,
    'ม้วน'::text as unit
  from source
)
insert into public.crm_products
  (sku, brand, product_type, series, model, size, stock, unit)
select sku, brand, product_type, series, model, size, stock, unit
from prepared product
where not exists (
  select 1
  from public.crm_products existing
  where lower(btrim(existing.brand)) = lower(btrim(product.brand))
    and lower(btrim(existing.product_type)) = lower(btrim(product.product_type))
    and lower(btrim(existing.series)) = lower(btrim(product.series))
    and lower(btrim(existing.model)) = lower(btrim(product.model))
    and lower(btrim(existing.size)) = lower(btrim(product.size))
);

