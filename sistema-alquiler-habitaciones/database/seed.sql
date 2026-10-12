-- Datos iniciales para alquiler_habitaciones
-- Ejecutar después de schema.sql.

INSERT INTO habitaciones (numero, capacidad, precio_mensual, estado, descripcion) VALUES
(1, 1, 400.00, 'DISPONIBLE', 'Cuarto para una persona.'),
(2, 2, 400.00, 'DISPONIBLE', 'Cuarto para un solo inquilino titular.'),
(3, 1, 400.00, 'DISPONIBLE', 'Cuarto para una persona.'),
(4, 2, 400.00, 'DISPONIBLE', 'Cuarto para un solo inquilino titular.'),
(5, 1, 400.00, 'DISPONIBLE', 'Cuarto para una persona.')
ON CONFLICT (numero) DO UPDATE SET
  capacidad = EXCLUDED.capacidad,
  precio_mensual = EXCLUDED.precio_mensual,
  estado = CASE WHEN habitaciones.estado = 'MANTENIMIENTO' THEN habitaciones.estado ELSE 'DISPONIBLE' END,
  descripcion = EXCLUDED.descripcion;
