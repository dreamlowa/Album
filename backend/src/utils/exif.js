import exifr from 'exifr';

/**
 * Прочитать EXIF из файла: дата съёмки + GPS-координаты.
 * Возвращает { dateTaken, latitude, longitude } или пустой объект.
 * Файлы без EXIF (скриншоты, пересланные фото) — не ошибка.
 */
export async function readExif(filePath) {
  const result = { dateTaken: null, latitude: null, longitude: null };

  try {
    // Только нужные теги — быстро и без загрузки всего файла в память целеком
    const data = await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude'],
    });

    if (data) {
      if (data.DateTimeOriginal || data.CreateDate) {
        const d = data.DateTimeOriginal || data.CreateDate;
        if (d instanceof Date && !Number.isNaN(d.getTime())) {
          result.dateTaken = d.toISOString();
        }
      }
      if (typeof data.GPSLatitude === 'number' && typeof data.GPSLongitude === 'number') {
        result.latitude = data.GPSLatitude;
        result.longitude = data.GPSLongitude;
      }
    }
  } catch (err) {
    // Нет EXIF / повреждённые данные — просто пропускаем
    console.warn('EXIF не прочитан:', err.message);
  }

  return result;
}