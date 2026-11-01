/**
 * Standard API response helpers.
 */
export function successResponse(res, data, { message, status = 200, meta } = {}) {
  const body = { success: true };
  if (message) body.message = message;
  if (meta) body.meta = meta;
  if (data !== undefined) body.data = data;
  return res.status(status).json(body);
}

export function createdResponse(res, data, message = 'Created successfully') {
  return successResponse(res, data, { message, status: 201 });
}

export function paginatedResponse(res, data, { total, page, limit, message } = {}) {
  return res.status(200).json({
    success: true,
    data,
    ...(message && { message }),
    meta: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
    },
  });
}

export function noContent(res) {
  return res.status(204).send();
}
